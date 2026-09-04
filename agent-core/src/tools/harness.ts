// Templates written into a "server"-kind tool's directory. The harness is our
// code, never the model's — the model only ever writes `operations.ts` (or, for
// tools built before that existed, `handler.ts`). The harness runs under Deno
// with a deny-by-default sandbox:
//
//   deno run --no-prompt --deny-import
//     --allow-net=127.0.0.1:<port>          (its own port only — can't reach
//                                            agent-core, Ollama, or the internet)
//     --allow-read=<toolDir>
//     --allow-write=<toolDir>/data          (scratch + its SQLite db)
//     server.ts <port>
//
// It also exits when its stdin closes, so a dead agent-core can't orphan it.
//
// Persistence is a real SQLite database (`node:sqlite`, a Deno builtin — no
// extra permission, and ATTACH is hard-disabled so it can't be pointed
// anywhere else) at `<toolDir>/data/tool.db`. Because `--allow-write` is
// scoped to `<toolDir>/data` and every tool has its own directory, that file
// is fully isolated per tool: no other tool's backend can open it.
//
// A "server" tool now exposes its operations three ways from one `operations`
// array (see builder.ts's OPERATIONS_SYSTEM):
//   - POST /mcp        — a minimal MCP server (JSON-RPC 2.0: initialize,
//                        tools/list, tools/call). This is what the chat agent
//                        calls (agent-core is the MCP client — see toolMcp.ts).
//   - GET|POST /api/<name>  — plain REST, for the tool's own web frontend.
//   - GET /__manifest  — the operation list as plain JSON, for the desktop
//                        Tools tab / debugging.
// The built-in GET/PUT /__state key-value store is unchanged.

export const HARNESS = String.raw`// AUTO-GENERATED — do not edit. See agent-core/src/tools/harness.ts.
import { DatabaseSync } from "node:sqlite";

const here = new URL(".", import.meta.url).pathname;
const DATA = here + "data/";
try {
  await Deno.mkdir(DATA, { recursive: true });
} catch {
  /* already exists */
}

// One private SQLite database per tool. --allow-write is scoped to DATA, so
// this file and its journal are the only things this process can persist to,
// and no other tool can reach it.
const db = new DatabaseSync(DATA + "tool.db");
// Guard against a runaway tool filling the user's disk (~64 MB at the default
// 4 KB page size). A write past this fails with SQLITE_FULL rather than growing.
db.exec("PRAGMA max_page_count = 16384");
db.exec("CREATE TABLE IF NOT EXISTS _kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

// Older server tools kept each key as a JSON file in data/. Import any that
// predate the database so an upgrade doesn't lose their state.
try {
  for (const entry of Deno.readDirSync(DATA)) {
    if (!entry.isFile || !entry.name.endsWith(".json")) continue;
    const key = entry.name.slice(0, -5);
    if (db.prepare("SELECT 1 FROM _kv WHERE key = ?").get(key)) continue;
    try {
      db.prepare("INSERT INTO _kv (key, value) VALUES (?, ?)").run(
        key,
        Deno.readTextFileSync(DATA + entry.name),
      );
    } catch {
      /* skip an unreadable legacy file */
    }
  }
} catch {
  /* data/ unreadable — nothing to migrate */
}

function safeKey(k: unknown): string {
  const s = String(k ?? "state").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return s || "state";
}

const MAX_VALUE_BYTES = 512 * 1024;

const store = {
  async get(key: string = "state"): Promise<unknown> {
    const row = db.prepare("SELECT value FROM _kv WHERE key = ?").get(safeKey(key)) as
      | { value: string }
      | undefined;
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return null;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    const body = JSON.stringify(value ?? null);
    if (body.length > MAX_VALUE_BYTES) throw new Error("value too large (max 512 KB)");
    db.prepare(
      "INSERT INTO _kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(safeKey(key), body);
  },
};

const ctx = { store, db };

// ---- the tool's own code ----
// New tools export an "operations" array from operations.ts; tools built before
// that existed export a single "handler" from handler.ts. Support both.
let operations: any[] = [];
let operationsError: string | null = null;
let hadOperationsFile = false;
try {
  Deno.statSync("./operations.ts");
  hadOperationsFile = true;
} catch {
  /* no operations.ts */
}
if (hadOperationsFile) {
  try {
    const mod = await import("./operations.ts");
    if (Array.isArray(mod.operations)) operations = mod.operations;
    else operationsError = "operations.ts does not export an 'operations' array";
  } catch (e) {
    // A broken operations.ts must be visible, not silently ignored — the
    // builder smoke-tests a new backend and needs to see this to repair it.
    operationsError = e instanceof Error ? e.message : String(e);
    console.error("OPERATIONS_LOAD_ERROR: " + operationsError);
  }
}

let legacyHandler: ((req: Request, ctx: unknown) => unknown) | null = null;
try {
  const mod = await import("./handler.ts");
  if (typeof mod.handler === "function") legacyHandler = mod.handler;
} catch {
  /* no handler.ts */
}

const opByName = new Map(operations.map((o) => [o.name, o]));

function opMeta(o: any) {
  return {
    name: o.name,
    title: o.title || o.name,
    description: o.description || o.name,
    inputSchema: o.inputSchema || { type: "object", properties: {} },
    annotations: { readOnlyHint: o.access === "read" },
  };
}

async function runOp(o: any, input: unknown): Promise<unknown> {
  const result = await o.run(input ?? {}, ctx);
  return result ?? null;
}

// A GET /api/<name> carries its input as query params (all strings) — coerce
// the ones the schema says are numbers / booleans.
function coerceBySchema(input: Record<string, string>, schema: any): Record<string, unknown> {
  const props = schema && schema.properties ? schema.properties : {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    const t = props[k] && props[k].type;
    if (t === "number" || t === "integer") out[k] = Number(v);
    else if (t === "boolean") out[k] = v === "true" || v === "1";
    else out[k] = v;
  }
  return out;
}

// ---- minimal MCP server (JSON-RPC 2.0) ----
const PROTOCOL_VERSION = "2025-06-18";
function rpcResult(id: unknown, result: unknown) {
  return Response.json({ jsonrpc: "2.0", id, result });
}
function rpcError(id: unknown, code: number, message: string) {
  return Response.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function handleMcp(req: Request): Promise<Response> {
  let msg: any;
  try {
    msg = await req.json();
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  const id = msg ? msg.id : undefined;
  const method = msg ? msg.method : undefined;
  const params = (msg && msg.params) || {};

  // A notification (no id) — e.g. notifications/initialized. Ack, no body.
  if (id === undefined || id === null) return new Response(null, { status: 202 });

  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "family-tool", version: "1" },
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: operations.map(opMeta) });
    case "tools/call": {
      const o = opByName.get(params.name);
      if (!o) return rpcError(id, -32602, "unknown tool: " + params.name);
      try {
        const value = await runOp(o, params.arguments || {});
        return rpcResult(id, {
          content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
          structuredContent: value && typeof value === "object" ? value : { value },
          isError: false,
        });
      } catch (e) {
        return rpcResult(id, {
          content: [{ type: "text", text: "operation failed: " + (e instanceof Error ? e.message : String(e)) }],
          isError: true,
        });
      }
    }
    default:
      return rpcError(id, -32601, "method not found: " + method);
  }
}

// A dead parent closes our stdin — exit cleanly rather than linger.
(async () => {
  try {
    for await (const _ of Deno.stdin.readable) { /* ignore input */ }
  } catch { /* ignore */ }
  Deno.exit(0);
})();

const port = Number(Deno.args[0]) || 0;

Deno.serve(
  { hostname: "127.0.0.1", port, onListen: ({ port }) => console.log("TOOL_READY " + port) },
  async (req: Request): Promise<Response> => {
    const url = new URL(req.url);

    // Built-in persistence so a handler never has to implement its own.
    if (url.pathname === "/__state") {
      const key = url.searchParams.get("key") ?? "state";
      if (req.method === "GET") return Response.json(await store.get(key));
      if (req.method === "PUT") {
        try {
          await store.set(key, await req.json());
          return new Response(null, { status: 204 });
        } catch (e) {
          return new Response(String(e instanceof Error ? e.message : e), { status: 400 });
        }
      }
      return new Response("method not allowed", { status: 405 });
    }

    // MCP endpoint — what the chat agent calls (agent-core is the client).
    if (url.pathname === "/mcp") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      try {
        return await handleMcp(req);
      } catch (e) {
        return rpcError(null, -32603, "internal error: " + (e instanceof Error ? e.message : String(e)));
      }
    }

    // The operation list as plain JSON — desktop Tools tab / debugging. Also
    // carries any operations.ts load error so the builder's smoke test can see it.
    if (url.pathname === "/__manifest") {
      return Response.json({
        operations: operations.map((o) => ({
          name: o.name,
          description: o.description || o.name,
          access: o.access === "read" ? "read" : "write",
          inputSchema: o.inputSchema || { type: "object", properties: {} },
        })),
        error: operationsError,
        hadOperationsFile,
      });
    }

    // Convenience REST for the tool's own frontend. Only claim /api/ when the
    // tool actually declared operations — otherwise a legacy handler that
    // routes /api/ itself still works.
    if (operations.length && url.pathname.startsWith("/api/")) {
      const name = decodeURIComponent(url.pathname.slice(5));
      const o = opByName.get(name);
      if (!o) return new Response("unknown operation: " + name, { status: 404 });
      let input: unknown = {};
      if (req.method === "GET") {
        input = coerceBySchema(Object.fromEntries(url.searchParams.entries()), o.inputSchema);
      } else if (req.method === "POST") {
        try {
          input = await req.json();
        } catch {
          input = {};
        }
      } else {
        return new Response("method not allowed", { status: 405 });
      }
      try {
        return Response.json(await runOp(o, input));
      } catch (e) {
        return new Response("operation failed: " + (e instanceof Error ? e.message : String(e)), { status: 500 });
      }
    }

    // Legacy custom handler (tools built before operations.ts).
    if (legacyHandler) {
      try {
        const out = await legacyHandler(req, ctx);
        return out instanceof Response ? out : Response.json(out ?? null);
      } catch (e) {
        return new Response("tool error: " + (e instanceof Error ? e.message : String(e)), { status: 500 });
      }
    }

    return new Response("not found", { status: 404 });
  },
);
`;

// Written when the model's operations generation fails — the frontend + the
// built-in /__state persistence still work, there just are no agent-callable
// operations.
export const DEFAULT_OPERATIONS = String.raw`// No operations were generated — the built-in /__state API still works.
export const operations: unknown[] = [];
`;
