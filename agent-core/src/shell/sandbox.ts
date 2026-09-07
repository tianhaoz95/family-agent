import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { config } from "../config.js";

// Runs one process inside a bubblewrap sandbox with NO network, a read-only
// view of the system, and read/write scoped to a single workspace directory.
// This is the shell equivalent of the Deno sandbox that backs builder tools
// (agent-core/src/tools/supervisor.ts) — deny-by-default, degrade to "off"
// if the sandbox binary is missing rather than run anything unconfined.

function resolveBwrap(): string | null {
  const candidates = [config.bwrapPath, "/usr/bin/bwrap", "/bin/bwrap"].filter(Boolean);
  for (const c of candidates) if (existsSync(c)) return c;
  // May still be on PATH.
  const which = spawnSync("bwrap", ["--version"], { timeout: 3000 });
  return which.status === 0 ? "bwrap" : null;
}

let cachedBwrap: string | null | undefined;
function bwrap(): string | null {
  if (cachedBwrap === undefined) cachedBwrap = resolveBwrap();
  return cachedBwrap;
}

/** Is the sandbox usable on this host? Runs a real (tiny) sandboxed command —
 *  bwrap can be installed but blocked (no unprivileged user namespaces). */
export function sandboxAvailable(): { ok: boolean; reason?: string } {
  const bin = bwrap();
  if (!bin) return { ok: false, reason: "bubblewrap (bwrap) is not installed" };
  const probe = spawnSync(bin, [...baseBwrapArgs("/tmp"), "--", "/bin/true"], { timeout: 5000 });
  if (probe.status === 0) return { ok: true };
  return {
    ok: false,
    reason:
      "bubblewrap is installed but can't create a sandbox here " +
      "(unprivileged user namespaces may be disabled: `sysctl kernel.unprivileged_userns_clone=1`)",
  };
}

// The read-only system mounts every CLI tool is likely to need. Kept tight —
// no /home, no /root, no /etc beyond what dynamic linking + CA certs want
// (there's no network anyway), no /proc mounts of the host.
function baseBwrapArgs(workdir: string, extraRoBinds: [string, string][] = []): string[] {
  const roBinds = ["/usr", "/bin", "/lib", "/lib64", "/sbin", "/etc/alternatives", "/etc/fonts", "/etc/ssl", "/etc/ca-certificates", "/etc/ImageMagick-6", "/etc/ImageMagick-7", "/opt"];
  const args = ["--unshare-all", "--die-with-parent", "--new-session"];
  for (const p of roBinds) if (existsSync(p)) args.push("--ro-bind", p, p);
  for (const [src, dest] of extraRoBinds) if (existsSync(src)) args.push("--ro-bind", src, dest);
  args.push(
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--bind", workdir, "/work",
    "--chdir", "/work",
    "--clearenv",
    "--setenv", "PATH", "/usr/bin:/bin:/usr/local/bin",
    "--setenv", "HOME", "/work",
    "--setenv", "LANG", "C.UTF-8",
    "--setenv", "LC_ALL", "C.UTF-8",
    "--setenv", "TMPDIR", "/tmp",
  );
  return args;
}

export interface SandboxResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * Run `argv` (already a full command + args array — no shell parsing) inside
 * the sandbox, with `workdir` mounted read/write at /work. Wall-clock capped
 * by `timeoutMs`; output captured up to `maxOutputBytes` each stream, then
 * the process is killed.
 */
export function runSandboxed(
  argv: string[],
  workdir: string,
  opts: {
    timeoutMs?: number;
    maxOutputBytes?: number;
    /** [hostPath, sandboxPath] pairs mounted read-only (e.g. a skill folder). */
    extraRoBinds?: [string, string][];
  } = {}
): Promise<SandboxResult> {
  const bin = bwrap();
  if (!bin) return Promise.resolve({ code: null, stdout: "", stderr: "sandbox unavailable", timedOut: false });
  const timeoutMs = opts.timeoutMs ?? config.shellTimeoutMs;
  const maxBytes = opts.maxOutputBytes ?? config.shellMaxOutputBytes;

  // ulimit inside the sandbox caps address space + output file size; `timeout`
  // outside is the hard wall-clock kill.
  const inner = ["sh", "-c", `ulimit -v 2097152 2>/dev/null; ulimit -f 1048576 2>/dev/null; exec "$@"`, "sh", ...argv];
  const full = [bin, ...baseBwrapArgs(workdir, opts.extraRoBinds), "--", ...inner];

  return new Promise((resolve) => {
    const proc = spawn(full[0], full.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const clip = (buf: string, chunk: Buffer) =>
      buf.length >= maxBytes ? buf : (buf + chunk.toString("utf8")).slice(0, maxBytes + 512);
    proc.stdout.on("data", (c) => (stdout = clip(stdout, c)));
    proc.stderr.on("data", (c) => (stderr = clip(stderr, c)));
    const killer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(killer);
      resolve({ code: null, stdout, stderr: stderr || String(err), timedOut });
    });
    proc.on("close", (code) => {
      clearTimeout(killer);
      resolve({
        code,
        stdout: stdout.slice(0, maxBytes),
        stderr: stderr.slice(0, maxBytes),
        timedOut,
      });
    });
  });
}
