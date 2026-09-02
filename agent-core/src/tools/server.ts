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

export function startToolsServer(store: Store, supervisor: ToolSupervisor) {
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

      const tool = store.getTool(id);
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

  server.listen(config.toolsPort, "127.0.0.1");
  return server;
}
