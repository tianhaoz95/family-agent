import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extname } from "node:path";
import { config } from "../config.js";
import { runSandboxed, sandboxAvailable } from "../shell/sandbox.js";
import { skillRootPath, skillScriptPath } from "./skills.js";

// Run one script that ships with a skill. The skill's folder is mounted
// read-only at /skill inside the bubblewrap sandbox (no network), with a fresh
// empty /work as the writable scratch dir. Same isolation guarantees as the
// workshop agent — see docs/DECISIONS.md → "Skills and MCP".

const INTERPRETER: Record<string, string[]> = {
  ".py": ["python3"],
  ".js": ["node"],
  ".mjs": ["node"],
  ".sh": ["sh"],
  ".bash": ["bash"],
};

export interface ScriptRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ran: boolean;
  reason?: string;
}

export function skillScriptsRunnable(): { ok: boolean; reason?: string } {
  const sb = sandboxAvailable();
  return sb.ok ? { ok: true } : { ok: false, reason: sb.reason };
}

export async function runSkillScript(
  skill: string,
  script: string,
  args: string[] = []
): Promise<ScriptRun> {
  const runnable = skillScriptsRunnable();
  if (!runnable.ok) {
    return { code: null, stdout: "", stderr: "", timedOut: false, ran: false, reason: runnable.reason };
  }
  let scriptPath: string;
  try {
    scriptPath = skillScriptPath(skill, script);
  } catch (err) {
    return { code: null, stdout: "", stderr: "", timedOut: false, ran: false, reason: (err as Error).message };
  }
  const ext = extname(scriptPath).toLowerCase();
  const interp = INTERPRETER[ext];
  if (!interp) {
    return {
      code: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      ran: false,
      reason: `"${script}" has an unsupported extension (${ext || "none"}). Supported: .py .js .mjs .sh .bash`,
    };
  }
  for (const a of args) {
    if (typeof a !== "string" || a.includes("\0")) {
      return { code: null, stdout: "", stderr: "", timedOut: false, ran: false, reason: "bad argument" };
    }
  }

  const work = mkdtempSync(join(tmpdir(), "fa-skill-"));
  try {
    const sandboxScript = "/skill/scripts/" + script.trim();
    const result = await runSandboxed([...interp, sandboxScript, ...args], work, {
      timeoutMs: config.skillScriptTimeoutMs,
      maxOutputBytes: config.computeMaxOutputChars, // reuse a sane 10k cap
      extraRoBinds: [[skillRootPath(skill), "/skill"]],
    });
    return { ...result, ran: true };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
