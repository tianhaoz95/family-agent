// Templates written into a "server"-kind tool's directory. The harness is our
// code, never the model's — the model only ever writes `handler.ts`. The
// harness runs under Deno with a deny-by-default sandbox:
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
// is fully isolated per tool: no other tool's backend can open it. The handler
// gets the raw `db` handle for relational data; the simpler key/value `store`
// (also what `GET/PUT /__state` uses) is now a thin table on top of it.

export const HARNESS = String.raw`// AUTO-GENERATED — do not edit. See agent-core/src/tools/harness.ts.
import { DatabaseSync } from "node:sqlite";
import { handler } from "./handler.ts";

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
// predate the database so an upgrade doesn't lose their state. The files are
// left in place (harmless, and a safety net for a downgrade).
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
    // The generated frontend can also hit this directly:
    //   fetch("/__state")                      -> current JSON (or null)
    //   fetch("/__state", {method:"PUT", body}) -> save
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

    try {
      const out = await handler(req, { store, db });
      return out instanceof Response ? out : Response.json(out ?? null);
    } catch (e) {
      return new Response("tool error: " + (e instanceof Error ? e.message : String(e)), { status: 500 });
    }
  },
);
`;

export const DEFAULT_HANDLER = String.raw`// No custom handler was generated — the built-in /__state API still works.
export function handler(_req: Request, _ctx: unknown): Response {
  return new Response("not found", { status: 404 });
}
`;
