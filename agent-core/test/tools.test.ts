import { describe, it, expect, afterEach } from "vitest";
import { rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { toolsDir } from "../src/config.js";
import { HARNESS } from "../src/tools/harness.js";
import { ToolSupervisor, resolveDenoPath } from "../src/tools/supervisor.js";

// Exercises the real Deno sandbox, so it only runs where Deno is available
// (repo-local toolchain or PATH) — like agents.integration.test.ts with Ollama.
const run = resolveDenoPath() ? describe : describe.skip;

run("ToolSupervisor sandbox", () => {
  const supervisor = new ToolSupervisor();
  const id = "ZTESTTOOL";
  const dir = join(toolsDir(), id);

  afterEach(() => {
    supervisor.stopAll();
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  });

  it("runs a generated tool, serves /__state, and denies a filesystem escape", async () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "server.ts"), HARNESS);
    writeFileSync(
      join(dir, "handler.ts"),
      `export async function handler(req: Request) {
        const url = new URL(req.url);
        if (url.pathname === "/ping") return new Response("pong");
        if (url.pathname === "/escape") {
          try { await Deno.readTextFile("/etc/hostname"); return new Response("LEAKED", { status: 500 }); }
          catch { return new Response("blocked"); }
        }
        if (url.pathname === "/reach-ollama") {
          try { await fetch("http://127.0.0.1:11434/api/version"); return new Response("REACHED", { status: 500 }); }
          catch { return new Response("blocked"); }
        }
        return new Response("nope", { status: 404 });
      }`
    );

    const port = await supervisor.start(id);
    expect(port).toBeGreaterThan(0);

    expect(await (await fetch(`http://127.0.0.1:${port}/ping`)).text()).toBe("pong");

    await fetch(`http://127.0.0.1:${port}/__state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chores: ["dishes"] }),
    });
    expect(await (await fetch(`http://127.0.0.1:${port}/__state`)).json()).toEqual({ chores: ["dishes"] });

    expect(await (await fetch(`http://127.0.0.1:${port}/escape`)).text()).toBe("blocked");
    expect(await (await fetch(`http://127.0.0.1:${port}/reach-ollama`)).text()).toBe("blocked");
  }, 30_000);

  it("gives the handler a private SQLite db that persists across restarts", async () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "server.ts"), HARNESS);
    writeFileSync(
      join(dir, "handler.ts"),
      `export async function handler(req: Request, ctx: any) {
        const url = new URL(req.url);
        ctx.db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
        if (req.method === "POST" && url.pathname === "/notes") {
          const { body } = await req.json();
          ctx.db.prepare("INSERT INTO notes (body) VALUES (?)").run(body);
          return new Response(null, { status: 204 });
        }
        if (url.pathname === "/notes") {
          return Response.json(ctx.db.prepare("SELECT body FROM notes ORDER BY id").all());
        }
        return new Response("nope", { status: 404 });
      }`
    );

    let port = await supervisor.start(id);
    await fetch(`http://127.0.0.1:${port}/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: "buy milk" }),
    });
    expect(await (await fetch(`http://127.0.0.1:${port}/notes`)).json()).toEqual([{ body: "buy milk" }]);
    expect(existsSync(join(dir, "data", "tool.db"))).toBe(true);

    // Restart the backend — the row must survive.
    supervisor.stop(id);
    await new Promise((r) => setTimeout(r, 500));
    port = await supervisor.start(id);
    expect(await (await fetch(`http://127.0.0.1:${port}/notes`)).json()).toEqual([{ body: "buy milk" }]);
  }, 30_000);

  it("migrates a legacy data/<key>.json blob into the _kv table", async () => {
    mkdirSync(join(dir, "data"), { recursive: true });
    writeFileSync(join(dir, "server.ts"), HARNESS);
    writeFileSync(join(dir, "handler.ts"), "export function handler() { return new Response('x'); }");
    // A pre-SQLite server tool persisted state as a JSON file.
    writeFileSync(join(dir, "data", "state.json"), JSON.stringify({ chores: ["dishes"] }));

    const port = await supervisor.start(id);
    expect(await (await fetch(`http://127.0.0.1:${port}/__state`)).json()).toEqual({ chores: ["dishes"] });
  }, 30_000);
});
