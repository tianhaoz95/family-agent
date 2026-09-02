// Templates written into a "server"-kind tool's directory. The harness is our
// code, never the model's — the model only ever writes `handler.ts`. The
// harness runs under Deno with a deny-by-default sandbox:
//
//   deno run --no-prompt --deny-import
//     --allow-net=127.0.0.1:<port>          (its own port only — can't reach
//                                            agent-core, Ollama, or the internet)
//     --allow-read=<toolDir>
//     --allow-write=<toolDir>/data          (scratch only)
//     server.ts <port>
//
// It also exits when its stdin closes, so a dead agent-core can't orphan it.

export const HARNESS = String.raw`// AUTO-GENERATED — do not edit. See agent-core/src/tools/harness.ts.
import { handler } from "./handler.ts";

const here = new URL(".", import.meta.url).pathname;
const DATA = here + "data/";
try {
  await Deno.mkdir(DATA, { recursive: true });
} catch {
  /* already exists */
}

function safeKey(k: unknown): string {
  const s = String(k ?? "state").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return s || "state";
}

const MAX_VALUE_BYTES = 512 * 1024;

const store = {
  async get(key: string = "state"): Promise<unknown> {
    try {
      return JSON.parse(await Deno.readTextFile(DATA + safeKey(key) + ".json"));
    } catch {
      return null;
    }
  },
  async set(key: string, value: unknown): Promise<void> {
    const body = JSON.stringify(value ?? null);
    if (body.length > MAX_VALUE_BYTES) throw new Error("value too large (max 512 KB)");
    await Deno.writeTextFile(DATA + safeKey(key) + ".json", body);
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
      const out = await handler(req, { store });
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
