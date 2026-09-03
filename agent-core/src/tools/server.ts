import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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
  // `same-origin`, not `no-referrer`: a tool page lives at `/<id>/` and a small
  // model routinely writes `fetch('/__state')` (an absolute path that would
  // otherwise miss the `/<id>/…` route). The server recovers the tool id from
  // the same-origin Referer of such a request — see `toolIdFromReferer`. The
  // referer never leaves this origin, so this leaks nothing.
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
}

/** Is `child` inside `parent`? Guards path traversal. */
function contains(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p + sep);
}

// Generated tools are told to persist through the built-in `/__state` API, but
// small models routinely reach for `localStorage` anyway — and a tool page runs
// in a cross-origin sandboxed iframe (desktop) / WebView (Android) whose
// `localStorage` the host webview does NOT reliably keep across an app restart
// (WebKitGTK partitions third-party frame storage and treats it as ephemeral).
// That silently lost every "local" tool's data on restart. This shim, injected
// into every served tool page before the tool's own script runs, mirrors
// `localStorage` to `/__state?key=__ls` (disk-backed, same origin) so those
// tools persist too. It also seeds `localStorage` from the server on load.
const LS_PERSIST_SHIM = `<script>(function(){
try{
  var K="__state?key=__ls";
  var x=new XMLHttpRequest();x.open("GET",K,false);x.send();
  if(x.status===200){var saved=JSON.parse(x.responseText||"null");
    if(saved&&typeof saved==="object"){for(var k in saved){try{localStorage.setItem(k,saved[k])}catch(e){}}}}
}catch(e){}
var t=null;
function flush(sync){
  try{var all={};for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);all[k]=localStorage.getItem(k)}
    var x=new XMLHttpRequest();x.open("PUT",K,!sync);
    x.setRequestHeader("content-type","application/json");x.send(JSON.stringify(all))}catch(e){}
}
function schedule(){if(t)clearTimeout(t);t=setTimeout(flush,120)}
function flushNow(){flush(true)}
try{
  var P=Storage.prototype,_s=P.setItem,_r=P.removeItem,_c=P.clear;
  P.setItem=function(k,v){_s.call(this,k,v);if(this===window.localStorage)schedule()};
  P.removeItem=function(k){_r.call(this,k);if(this===window.localStorage)schedule()};
  P.clear=function(){_c.call(this);if(this===window.localStorage)schedule()};
}catch(e){}
window.addEventListener("pagehide",flushNow);
window.addEventListener("beforeunload",flushNow);
document.addEventListener("visibilitychange",function(){if(document.visibilityState==="hidden")flushNow()});
})();</script>`;

// Recover a tool id from the `pathname` of a same-origin Referer — used when a
// request comes in for an absolute path (`/__state`, `/app.js`, …) that doesn't
// carry the `/<id>/` prefix. Generated tools do this constantly.
function toolIdFromReferer(referer: string | undefined): string | null {
  if (!referer) return null;
  try {
    const m = new URL(referer).pathname.match(/^\/([0-9A-Za-z]{4,16})(?:\/|$)/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Rewrite the served HTML so a tool that persists through the built-in state API
// actually reaches it: (1) a `<base href="/<id>/">` so relative URLs resolve
// under the tool's own path, and (2) absolute `"/__state"` string literals (the
// exact form the builder prompt used to hand the model, and which small models
// still produce) rewritten to the relative `"__state"`. The `<base>` alone
// can't fix an absolute path. Also injects the localStorage persistence shim.
function prepareHtml(html: string, id: string): string {
  if (html.includes("__state?key=__ls")) return html;
  let out = html.replace(/(["'`])\/__state\b/g, "$1__state");
  const baseTag = `<base href="/${id}/">`;
  const inject = (html.match(/<base[^>]*>/i) ? "" : baseTag) + LS_PERSIST_SHIM;
  const head = out.match(/<head[^>]*>/i);
  if (head) return out.replace(head[0], head[0] + inject);
  const body = out.match(/<body[^>]*>/i);
  if (body) return out.replace(body[0], body[0] + inject);
  return inject + out;
}

// Disk-backed `/__state` for static tools (server tools get it from their Deno
// backend instead). One JSON file per key under the tool's `data/` dir — the
// same `data/<key>.json` layout the Deno harness already migrates from, so a
// tool's state is portable between the two paths.
function safeStateKey(k: string | null): string {
  const s = String(k ?? "state").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return s || "state";
}

async function handleStaticState(
  dir: string,
  req: IncomingMessage,
  res: ServerResponse,
  search: URLSearchParams
): Promise<void> {
  const file = join(dir, "data", safeStateKey(search.get("key")) + ".json");
  if (!contains(join(dir, "data"), file)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  if (req.method === "GET") {
    let body = "null";
    try {
      body = (await readFile(file, "utf8")) || "null";
    } catch {
      /* no state yet */
    }
    securityHeaders(res, "application/json; charset=utf-8");
    res.writeHead(200).end(body);
    return;
  }
  if (req.method === "PUT") {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      res.writeHead(400).end("invalid json");
      return;
    }
    const out = JSON.stringify(parsed ?? null);
    if (out.length > 512 * 1024) {
      res.writeHead(400).end("value too large (max 512 KB)");
      return;
    }
    try {
      await mkdir(join(dir, "data"), { recursive: true });
      await writeFile(file, out);
    } catch (e) {
      res.writeHead(500).end(`could not save: ${e instanceof Error ? e.message : e}`);
      return;
    }
    securityHeaders(res, "text/plain; charset=utf-8");
    res.writeHead(204).end();
    return;
  }
  res.writeHead(405).end("method not allowed");
}

async function serveStatic(id: string, dir: string, relPath: string, res: ServerResponse): Promise<boolean> {
  const clean = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const full = join(dir, clean || "index.html");
  if (!contains(dir, full)) {
    res.writeHead(403).end("forbidden");
    return true;
  }
  try {
    const s = await stat(full);
    if (!s.isFile()) return false;
    const type = MIME[extname(full).toLowerCase()] ?? "application/octet-stream";
    securityHeaders(res, type);
    if (type.startsWith("text/html")) {
      res.writeHead(200).end(prepareHtml(await readFile(full, "utf8"), id));
    } else {
      res.writeHead(200).end(await readFile(full));
    }
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
      // Normal shape is `/<id>/<rest>`. A generated tool page also makes
      // absolute-path requests with no `/<id>/` prefix (`fetch('/__state')`,
      // `<script src="/app.js">`); recover the id from the same-origin Referer
      // and treat the whole path as `<rest>`.
      const m = url.pathname.match(/^\/([0-9A-Za-z]{4,16})(\/.*)?$/);
      let id: string;
      let rest: string;
      if (m) {
        id = m[1];
        rest = m[2] ?? "/";
      } else {
        const refId = toolIdFromReferer(req.headers.referer);
        if (!refId) {
          res.writeHead(404).end("not found");
          return;
        }
        id = refId;
        rest = url.pathname;
      }
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
      if (await serveStatic(id, dir, relPath, res)) return;

      // Built-in persistence for static tools (server tools get `/__state`
      // from their Deno backend via the proxy below).
      if (relPath === "__state" && tool.kind !== "server") {
        await handleStaticState(dir, req, res, url.searchParams);
        return;
      }

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
