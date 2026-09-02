import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { config, toolsDir } from "../config.js";

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

  async start(id: string): Promise<number> {
    const dir = join(toolsDir(), id);
    if (!existsSync(join(dir, "server.ts"))) throw new Error("tool has no server.ts");
    const deno = resolveDenoPath() ?? "deno";
    const port = await freePort();

    const proc = spawn(
      deno,
      [
        "run",
        "--no-prompt",
        "--deny-import",
        `--allow-net=127.0.0.1:${port}`,
        `--allow-read=${dir}`,
        `--allow-write=${join(dir, "data")}`,
        "--v8-flags=--max-old-space-size=128",
        join(dir, "server.ts"),
        String(port),
      ],
      { cwd: dir, stdio: ["pipe", "pipe", "pipe"] },
    ) as ChildProcessWithoutNullStreams;

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
