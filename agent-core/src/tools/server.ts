import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { config, toolsDir } from "../config.js";
import type { Store } from "../db.js";
import type { ToolSupervisor } from "./supervisor.js";

// Generated tools are served from THIS server, on their own port, never from
// agent-core's main API. A tool page therefore cannot fetch /tasks, /documents,
// or the Ollama endpoint — different origin, and the CSP below pins
// connect-src to 'self'. Server-kind tools get their non-file requests proxied
// to a sandboxed Deno backend that itself can only reach its own loopback port.
//
// frame-ancestors: the desktop app embeds a tool in an <iframe> inside its
// single window, so it must be allowed to frame this origin — but only the
// local app (Tauri's own scheme, or a localhost dev/preview origin), nothing
// remote. The tool still can't touch the app: cross-origin iframe + the
// iframe's `sandbox` attribute + connect-src 'self' here.
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "media-src 'self' blob: data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'self' tauri: http://localhost:* http://127.0.0.1:*",
].join("; ");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function securityHeaders(res: ServerResponse, contentType: string) {
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Security-Policy", CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}

/** Is `child` inside `parent`? Guards path traversal. */
function contains(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

async function serveStatic(dir: string, relPath: string, res: ServerResponse): Promise<boolean> {
  const clean = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = join(dir, clean || "index.html");
  if (!contains(dir, full)) {
    res.writeHead(403).end("forbidden");
    return true;
  }
  try {
    const s = await stat(full);
    if (!s.isFile()) return false;
    const body = await readFile(full);
    securityHeaders(res, MIME[extname(full).toLowerCase()] ?? "application/octet-stream");
    res.writeHead(200).end(body);
    return true;
  } catch {
    return false;
  }
}

async function proxyToBackend(port: number, req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const method = req.method ?? "GET";
  let upstream: Response;
  try {
    upstream = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { "content-type": req.headers["content-type"] ?? "application/json" },
      body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (e) {
    res.writeHead(502).end(`tool backend unreachable: ${e instanceof Error ? e.message : e}`);
    return;
  }
  const buf = Buffer.from(await upstream.arrayBuffer());
  securityHeaders(res, upstream.headers.get("content-type") ?? "text/plain; charset=utf-8");
  res.writeHead(upstream.status).end(buf);
}

export async function startToolsServer(store: Store, supervisor: ToolSupervisor) {
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://tools.local");
      // /<id>/<rest>
      const m = url.pathname.match(/^\/([0-9A-Za-z]{4,16})(\/.*)?$/);
      if (!m) {
        res.writeHead(404).end("not found");
        return;
      }
      const id = m[1];
      const rest = m[2] ?? "/";
      if (rest === "") {
        res.writeHead(302, { Location: `/${id}/` }).end();
        return;
      }

      const tool = store.getToolAny(id);
      if (!tool || tool.status !== "ready") {
        res.writeHead(404).end("tool not found");
        return;
      }

      const dir = join(toolsDir(), id);
      const relPath = decodeURIComponent(rest.replace(/^\//, "")) || "index.html";

      // Try a real file first (frontends are static even for server tools).
      if (await serveStatic(dir, relPath, res)) return;

      // Otherwise, for server tools, hand it to the sandboxed backend.
      if (tool.kind === "server") {
        try {
          const port = await supervisor.portFor(id);
          await proxyToBackend(port, req, res, rest + url.search);
        } catch (e) {
          res.writeHead(502).end(`tool backend error: ${e instanceof Error ? e.message : e}`);
        }
        return;
      }

      res.writeHead(404).end("not found");
    } catch (e) {
      res.writeHead(500).end(`tools server error: ${e instanceof Error ? e.message : e}`);
    }
  });

  await listenWithRetry(server, config.toolsPort, "tools server");

  // Past the initial bind, a late socket error (e.g. the OS reclaiming the port)
  // must not become an unhandled 'error' event that takes the whole process
  // down — log it and keep serving what we can.
  server.on("error", (err) => console.error("tools server socket error:", err));

  return server;
}

/**
 * Bind an http server, retrying briefly on EADDRINUSE. During `tauri:dev` a Rust
 * rebuild kills and respawns the app; the new agent-core can race the old one's
 * shutdown and find the port still held for a moment. Without this that surfaced
 * as an unhandled EADDRINUSE 'error' event and a hard crash (see docs/DECISIONS.md).
 */
export function listenWithRetry(
  server: import("node:http").Server,
  port: number,
  label: string,
  timeoutMs = 8000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let warned = false;
  const attempt = (): Promise<void> =>
    new Promise((resolvePromise, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (err.code === "EADDRINUSE" && Date.now() < deadline) {
          if (!warned) {
            console.log(
              `${label}: port ${port} busy (a previous instance is shutting down) — retrying for up to ${Math.round(timeoutMs / 1000)}s…`
            );
            warned = true;
          }
          setTimeout(() => attempt().then(resolvePromise, reject), 400);
          return;
        }
        if (err.code === "EADDRINUSE") {
          reject(
            new Error(
              `${label}: port ${port} is already in use and did not free up. ` +
                `Another agent-core is running (or an orphan from a previous run). ` +
                `Stop it with:  kill $(lsof -ti tcp:${port})`
            )
          );
          return;
        }
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolvePromise();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      // 0.0.0.0, not 127.0.0.1: the Android app views a generated tool in a
      // WebView over the LAN, so it has to be able to reach this port from
      // another device. The strict CSP above still applies, and a tool's
      // page still can't reach agent-core's authed API (different origin,
      // connect-src 'self'). See docs/DECISIONS.md.
      server.listen(port, "0.0.0.0");
    });
  return attempt();
}
