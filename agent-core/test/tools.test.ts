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
});
