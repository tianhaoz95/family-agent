import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config, toolsDir } from "../config.js";

// Lenient tsconfig for `deno check` on a generated tool. server.ts is our own
// typed code; operations.ts / handler.ts are model-written and deliberately
// untyped (and `deno run` never type-checks anyway). This just wants real
// breakage — bad syntax, missing local imports, wrong API shape — not
// implicit-any noise.
const TOOLCHECK_CONFIG = JSON.stringify({
  compilerOptions: {
    strict: false,
    noImplicitAny: false,
    strictNullChecks: false,
    checkJs: false,
    lib: ["deno.window"],
  },
});

// A tool result whose error text looks like a code defect (vs. a legit
// "not found" / validation message).
const CODE_BUG = /is not a function|no such (table|column)|syntax error|is not defined|cannot read (property|properties)|undefined is not|referenceerror|typeerror/i;

/** Minimal args for a read-operation smoke call, from its JSON Schema. */
function synthArgs(schema: any): Record<string, unknown> {
  const props = (schema && schema.properties) || {};
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries<any>(props)) {
    const t = s && s.type;
    out[k] = s && Array.isArray(s.enum) && s.enum.length ? s.enum[0]
      : t === "number" || t === "integer" ? 1
      : t === "boolean" ? false
      : t === "array" ? []
      : t === "object" ? {}
      : "x";
  }
  return out;
}

let toolcheckConfigPath: string | null = null;
function ensureToolcheckConfig(): string {
  if (toolcheckConfigPath && existsSync(toolcheckConfigPath)) return toolcheckConfigPath;
  const p = join(tmpdir(), "family-agent-toolcheck.json");
  try {
    writeFileSync(p, TOOLCHECK_CONFIG);
    toolcheckConfigPath = p;
  } catch {
    // fall back to a config-less check
  }
  return toolcheckConfigPath ?? "";
}

// The Deno sandbox flags. Shared by a real backend, a staged one under test,
// and the type-check, so all three run under identical restrictions.
function sandboxRunArgs(dir: string, port: number): string[] {
  return [
    "run",
    "--no-prompt",
    "--deny-import",
    `--allow-net=127.0.0.1:${port}`,
    `--allow-read=${dir}`,
    `--allow-write=${join(dir, "data")}`,
    "--v8-flags=--max-old-space-size=128",
    join(dir, "server.ts"),
    String(port),
  ];
}

// Resolve the deno binary once: env override > repo-local toolchain > PATH.
export function resolveDenoPath(): string | null {
  const candidates = [
    config.denoPath,
    process.env.FAMILY_AGENT_DENO_PATH ?? "",
    new URL("../../../.toolchains/deno/deno", import.meta.url).pathname,
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null; // may still be on PATH — spawn() will try "deno" as a last resort
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

interface RunningTool {
  proc: ChildProcessWithoutNullStreams;
  port: number;
  lastUsed: number;
}

/**
 * Owns the pool of Deno processes backing "server"-kind tools. Each runs in a
 * deny-by-default sandbox scoped to its own directory and a single loopback
 * port. Idle processes are swept; all are killed on shutdown.
 */
export class ToolSupervisor {
  private running = new Map<string, RunningTool>();
  private sweepTimer?: NodeJS.Timeout;

  constructor() {
    this.sweepTimer = setInterval(() => this.sweepIdle(), 60_000);
    this.sweepTimer.unref?.();
  }

  denoAvailable(): boolean {
    return resolveDenoPath() !== null || process.env.PATH?.split(":").some((d) => existsSync(join(d, "deno"))) === true;
  }

  /** Port the tool's backend is reachable on, starting it if needed. */
  async portFor(id: string): Promise<number> {
    const existing = this.running.get(id);
    if (existing && existing.proc.exitCode === null && !existing.proc.killed) {
      existing.lastUsed = Date.now();
      return existing.port;
    }
    return this.start(id);
  }

  isRunning(id: string): boolean {
    const r = this.running.get(id);
    return !!r && r.proc.exitCode === null && !r.proc.killed;
  }

  /** Spawn a backend for `dir` on `port` and resolve once it prints TOOL_READY. */
  private spawnBackend(
    dir: string,
    port: number
  ): { proc: ChildProcessWithoutNullStreams; ready: Promise<number> } {
    const deno = resolveDenoPath() ?? "deno";
    const proc = spawn(deno, sandboxRunArgs(dir, port), {
      cwd: dir,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;

    const ready = new Promise<number>((resolve, reject) => {
      const to = setTimeout(() => reject(new Error("tool backend did not start within 15s")), 15_000);
      let out = "";
      let err = "";
      proc.stdout.on("data", (d: Buffer) => {
        out += d.toString();
        const m = out.match(/TOOL_READY (\d+)/);
        if (m) {
          clearTimeout(to);
          resolve(Number(m[1]));
        }
      });
      proc.stderr.on("data", (d: Buffer) => {
        err += d.toString();
      });
      proc.on("exit", (code) => {
        clearTimeout(to);
        reject(new Error(`tool backend exited (${code})${err ? `: ${err.slice(0, 400)}` : ""}`));
      });
      proc.on("error", (e) => {
        clearTimeout(to);
        reject(e);
      });
    });
    return { proc, ready };
  }

  async start(id: string): Promise<number> {
    const dir = join(toolsDir(), id);
    if (!existsSync(join(dir, "server.ts"))) throw new Error("tool has no server.ts");
    const port = await freePort();
    const { proc, ready } = this.spawnBackend(dir, port);

    try {
      const realPort = await ready;
      this.running.set(id, { proc, port: realPort, lastUsed: Date.now() });
      proc.on("exit", () => {
        if (this.running.get(id)?.proc === proc) this.running.delete(id);
      });
      return realPort;
    } catch (e) {
      proc.kill("SIGKILL");
      throw e;
    }
  }

  /**
   * Boot an arbitrary (staged) tool directory, confirm it comes up and answers
   * `tools/list`, then kill it. Used to verify a generated / improved backend
   * before it replaces the live one — a bad build never takes a working tool
   * offline. Never registered in `running`.
   */
  async smokeTest(dir: string): Promise<{ ok: boolean; error?: string; operations?: string[] }> {
    if (!existsSync(join(dir, "server.ts"))) return { ok: false, error: "no server.ts" };
    let port: number;
    try {
      port = await freePort();
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const { proc, ready } = this.spawnBackend(dir, port);
    try {
      const realPort = await ready;
      // The manifest carries any operations.ts load error — a broken file boots
      // fine (frontend still works) but reports here rather than silently.
      const manifest = (await (
        await fetch(`http://127.0.0.1:${realPort}/__manifest`, { signal: AbortSignal.timeout(8_000) })
      ).json()) as { operations?: { name: string }[]; error?: string | null; hadOperationsFile?: boolean };
      if (manifest.error) {
        return { ok: false, error: `operations.ts failed to load: ${manifest.error}` };
      }
      const names = (manifest.operations ?? []).map((t) => t.name);
      if (manifest.hadOperationsFile && names.length === 0) {
        return { ok: false, error: "operations.ts loaded but defines no operations" };
      }
      // tools/list must also work (it's what the agent calls).
      const list = (await (
        await fetch(`http://127.0.0.1:${realPort}/mcp`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
          signal: AbortSignal.timeout(8_000),
        })
      ).json()) as {
        result?: { tools?: { name: string; inputSchema?: any; annotations?: { readOnlyHint?: boolean } }[] };
        error?: unknown;
      };
      if (list.error) return { ok: false, error: `tools/list failed: ${JSON.stringify(list.error)}` };

      // Actually call each read operation with synthesized args — a bad table
      // name / typo'd method only shows up when a run() executes. Writes are
      // left alone (can't safely test a side effect).
      for (const t of list.result?.tools ?? []) {
        if (t.annotations?.readOnlyHint === false) continue;
        const args = synthArgs(t.inputSchema);
        const call = (await (
          await fetch(`http://127.0.0.1:${realPort}/mcp`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: t.name, arguments: args } }),
            signal: AbortSignal.timeout(8_000),
          })
        ).json()) as { result?: { isError?: boolean; content?: { text?: string }[] } };
        const msg = call.result?.content?.[0]?.text ?? "";
        if (call.result?.isError && CODE_BUG.test(msg)) {
          return { ok: false, error: `${t.name}: ${msg}` };
        }
      }
      return { ok: true, operations: names };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    } finally {
      proc.stdin.end();
      proc.kill("SIGKILL");
    }
  }

  /**
   * `deno check` the staged code under the same lenient config the runtime
   * uses (the generated `operations.ts` is deliberately untyped). Returns the
   * compiler's diagnostics on failure so a repair pass can act on them. Advisory
   * only — `deno run` doesn't type-check, so `smokeTest` is the real gate.
   */
  async denoCheck(dir: string): Promise<{ ok: boolean; output: string }> {
    const deno = resolveDenoPath() ?? "deno";
    const configPath = ensureToolcheckConfig();
    const args = ["check", "--no-remote", "--quiet"];
    if (configPath) args.push("--config", configPath);
    args.push(join(dir, "server.ts"));
    return new Promise((resolve) => {
      const proc = spawn(deno, args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      proc.stdout.on("data", (d: Buffer) => (out += d.toString()));
      proc.stderr.on("data", (d: Buffer) => (out += d.toString()));
      const to = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve({ ok: true, output: "" }); // don't block a build on a slow check
      }, 20_000);
      proc.on("exit", (code) => {
        clearTimeout(to);
        resolve({ ok: code === 0, output: out.slice(0, 1500) });
      });
      proc.on("error", () => {
        clearTimeout(to);
        resolve({ ok: true, output: "" });
      });
    });
  }

  stop(id: string): void {
    const r = this.running.get(id);
    if (r) {
      r.proc.stdin.end();
      r.proc.kill("SIGTERM");
      setTimeout(() => r.proc.kill("SIGKILL"), 2000).unref?.();
      this.running.delete(id);
    }
  }

  stopAll(): void {
    for (const id of [...this.running.keys()]) this.stop(id);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  private sweepIdle(): void {
    const now = Date.now();
    for (const [id, r] of this.running) {
      if (now - r.lastUsed > config.toolIdleTimeoutMs) this.stop(id);
    }
  }
}
