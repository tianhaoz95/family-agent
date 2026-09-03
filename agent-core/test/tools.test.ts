import { describe, it, expect, afterEach } from "vitest";
import { rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { config, toolsDir } from "../src/config.js";
import { Store } from "../src/db.js";
import { HARNESS } from "../src/tools/harness.js";
import { startToolsServer } from "../src/tools/server.js";
import { ToolSupervisor, resolveDenoPath } from "../src/tools/supervisor.js";

describe("static tool persistence (no Deno)", () => {
  const supervisor = new ToolSupervisor();
  let server: Awaited<ReturnType<typeof startToolsServer>> | undefined;
  const cleanup: string[] = [];

  afterEach(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
    supervisor.stopAll();
    for (const d of cleanup.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  async function boot(): Promise<{ store: Store; base: string; id: string }> {
    // startToolsServer binds config.toolsPort; use an ephemeral port for the test.
    config.toolsPort = 0;
    const store = new Store(":memory:");
    const user = store.createUser({ username: "u", displayName: "u", password: "sekret123", role: "admin" });
    const scoped = store.scoped(user.id);
    const tool = scoped.createTool({ name: "Recipes", description: "recipe box", prompt: "recipe box", kind: "static" });
    scoped.setToolStatus(tool.id, "ready");
    const dir = join(toolsDir(), tool.id);
    mkdirSync(dir, { recursive: true });
    cleanup.push(dir);
    writeFileSync(join(dir, "index.html"), "<!doctype html><html><head><title>Recipes</title></head><body>hi</body></html>");
    server = await startToolsServer(store, supervisor);
    const port = (server.address() as AddressInfo).port;
    return { store, base: `http://127.0.0.1:${port}/${tool.id}`, id: tool.id };
  }

  it("serves /__state for a static tool and persists it to disk across a server restart", async () => {
    const { store, base, id } = await boot();

    expect(await (await fetch(`${base}/__state?key=recipes`)).json()).toBe(null);

    const put = await fetch(`${base}/__state?key=recipes`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([{ name: "Chili", steps: "simmer" }]),
    });
    expect(put.status).toBe(204);
    expect(await (await fetch(`${base}/__state?key=recipes`)).json()).toEqual([{ name: "Chili", steps: "simmer" }]);
    expect(existsSync(join(toolsDir(), id, "data", "recipes.json"))).toBe(true);

    // Restart the tools server (stand-in for an app restart) — the state file
    // is on disk, so it must still be there.
    await new Promise<void>((r) => server!.close(() => r()));
    server = await startToolsServer(store, supervisor);
    const port = (server.address() as AddressInfo).port;
    const after = `http://127.0.0.1:${port}/${id}`;
    expect(await (await fetch(`${after}/__state?key=recipes`)).json()).toEqual([{ name: "Chili", steps: "simmer" }]);
  });

  it("injects the localStorage persistence shim and a <base> into the served HTML", async () => {
    const { base, id } = await boot();
    const html = await (await fetch(`${base}/`)).text();
    expect(html).toContain("__state?key=__ls");
    expect(html).toContain(`<base href="/${id}/">`);
    expect(html.indexOf("__state?key=__ls")).toBeLessThan(html.indexOf("hi"));
  });

  it("rewrites an absolute /__state literal in the served HTML to a relative path", async () => {
    config.toolsPort = 0;
    const store = new Store(":memory:");
    const user = store.createUser({ username: "u", displayName: "u", password: "sekret123", role: "admin" });
    const scoped = store.scoped(user.id);
    const tool = scoped.createTool({ name: "T", description: "d", prompt: "p", kind: "static" });
    scoped.setToolStatus(tool.id, "ready");
    const dir = join(toolsDir(), tool.id);
    mkdirSync(dir, { recursive: true });
    cleanup.push(dir);
    writeFileSync(
      join(dir, "index.html"),
      `<!doctype html><html><head><title>T</title></head><body><script>fetch("/__state").then(r=>r.json())</script></body></html>`
    );
    server = await startToolsServer(store, supervisor);
    const port = (server.address() as AddressInfo).port;
    const html = await (await fetch(`http://127.0.0.1:${port}/${tool.id}/`)).text();
    expect(html).toContain(`fetch("__state")`);
    expect(html).not.toContain(`fetch("/__state")`);
  });

  it("routes an absolute /__state request (no /<id>/ prefix) via the Referer", async () => {
    const { base, id } = await boot();
    const origin = base.slice(0, base.lastIndexOf("/"));
    const referer = `${base}/`;

    const put = await fetch(`${origin}/__state?key=k`, {
      method: "PUT",
      headers: { "content-type": "application/json", referer },
      body: JSON.stringify({ hi: 1 }),
    });
    expect(put.status).toBe(204);
    expect(await (await fetch(`${origin}/__state?key=k`, { headers: { referer } })).json()).toEqual({ hi: 1 });
    // Same file the prefixed route writes.
    expect(existsSync(join(toolsDir(), id, "data", "k.json"))).toBe(true);
    // No Referer → can't tell which tool → 404, not a silent wrong write.
    expect((await fetch(`${origin}/__state?key=k`)).status).toBe(404);
  });

  it("rejects oversized state", async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/__state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: "x".repeat(600 * 1024) }),
    });
    expect(res.status).toBe(400);
  });
});

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

  it("proxies /__state to the backend through the tools server, incl. an absolute path via Referer", async () => {
    config.toolsPort = 0;
    const store = new Store(":memory:");
    const user = store.createUser({ username: "u", displayName: "u", password: "sekret123", role: "admin" });
    const scoped = store.scoped(user.id);
    const t = scoped.createTool({ name: "T", description: "d", prompt: "p", kind: "server" });
    scoped.setToolStatus(t.id, "ready");
    const tdir = join(toolsDir(), t.id);
    mkdirSync(join(tdir, "data"), { recursive: true });
    writeFileSync(join(tdir, "server.ts"), HARNESS);
    writeFileSync(join(tdir, "handler.ts"), "export function handler() { return new Response('x'); }");
    writeFileSync(join(tdir, "index.html"), "<!doctype html><html><head><title>T</title></head><body>hi</body></html>");

    const server = await startToolsServer(store, supervisor);
    try {
      const port = (server.address() as import("node:net").AddressInfo).port;
      const origin = `http://127.0.0.1:${port}`;
      const referer = `${origin}/${t.id}/`;

      // Prefixed path.
      let put = await fetch(`${origin}/${t.id}/__state`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ a: 1 }),
      });
      expect(put.status).toBe(204);
      expect(await (await fetch(`${origin}/${t.id}/__state`)).json()).toEqual({ a: 1 });

      // Absolute path as a small model writes it — recovered via Referer.
      put = await fetch(`${origin}/__state`, {
        method: "PUT",
        headers: { "content-type": "application/json", referer },
        body: JSON.stringify({ a: 2 }),
      });
      expect(put.status).toBe(204);
      expect(await (await fetch(`${origin}/__state`, { headers: { referer } })).json()).toEqual({ a: 2 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      supervisor.stopAll();
    }
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
