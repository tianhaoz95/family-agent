import { getQuickJS, type QuickJSWASMModule } from "quickjs-emscripten";
import { config } from "../config.js";

// A stateless "run this snippet and give me the answer" sandbox. The planner
// (and document-agent) use it for arithmetic, date math, and small data
// analysis — a 2B model does those wrong in its head, code doesn't.
//
// The runtime is QuickJS compiled to WebAssembly (quickjs-emscripten): the
// module has NO syscalls — no filesystem, no network, no clock, no env, no
// randomness source. Isolation is structural, not a policy. On top of that we
// cap memory, stack, wall-clock (the interrupt handler fires from inside the
// interpreter loop AND the regex engine — verified), and output size.
//
// This is deliberately NOT a builder tool (no persistence, no UI, no state)
// and NOT the workshop agent (no files, no CLI, no bubblewrap dependency).
// It's a pure function the agent calls mid-conversation.

export interface RunResult {
  /** JSON-serialisable value of the snippet's last expression (or `undefined`). */
  result: unknown;
  /** Captured console.log / console.error lines, in order. */
  logs: string[];
  /** Set when the snippet threw or failed to parse. */
  error?: string;
  /** Set when it hit the wall-clock or memory limit. */
  limitHit?: "time" | "memory";
}

let modulePromise: Promise<QuickJSWASMModule> | null = null;
function loadModule(): Promise<QuickJSWASMModule> {
  if (!modulePromise) modulePromise = getQuickJS();
  return modulePromise;
}

/** Pre-warm the wasm module at startup so the first `run_code` isn't slow. */
export async function warmCompute(): Promise<void> {
  if (!config.computeEnabled) return;
  await loadModule().catch(() => {});
}

// Prepended to every snippet. globalThis is used (not `const`) so the
// snippet's own top-level `const`/`let` don't collide, and so the trailing
// expression of the snippet is still the program's completion value (an IIFE
// wrapper would swallow it).
function preamble(rawInput: string, nowIso: string): string {
  return `
"use strict";
globalThis.__logs = [];
(() => {
  const fmt = (a) => { try { return typeof a === "string" ? a : JSON.stringify(a); } catch { return String(a); } };
  const push = (...a) => { globalThis.__logs.push(a.map(fmt).join(" ")); };
  globalThis.console = { log: push, error: push, warn: push, info: push, debug: push };
})();
globalThis.input = ${rawInput === "undefined" ? "null" : `JSON.parse(${rawInput})`};
globalThis.NOW = ${JSON.stringify(nowIso)};
undefined;
`;
}
// The trailing bare `undefined;` is the program's completion value UNLESS the
// snippet ends with its own expression — so an all-declarations snippet yields
// `result: undefined` rather than leaking a preamble assignment's value.

/**
 * Run `code` (JavaScript) in the sandbox. `input` (any JSON value) is exposed
 * to the snippet as a global `input`; `now` (default: real time) as `NOW`
 * (an ISO string). The value of the snippet's last expression is returned as
 * `result`.
 */
export async function runCode(
  code: string,
  input?: unknown,
  opts: { now?: Date; timeoutMs?: number } = {}
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? config.computeTimeoutMs;
  const maxChars = config.computeMaxOutputChars;
  const QuickJS = await loadModule();

  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(config.computeMemoryBytes);
  rt.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  rt.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      timedOut = true;
      return true;
    }
    return false;
  });

  const ctx = rt.newContext();
  try {
    // Inject input + NOW as string globals the preamble parses.
    let rawInput = "undefined";
    if (input !== undefined) {
      try {
        rawInput = JSON.stringify(JSON.stringify(input));
      } catch {
        rawInput = "undefined";
      }
    }
    const now = (opts.now ?? new Date()).toISOString();
    // No IIFE wrap: the snippet's trailing expression IS the program's
    // completion value, matching the Node-REPL model the tool description
    // promises. A top-level `return` therefore errors — the prompt says to end
    // with an expression.
    const program = `${preamble(rawInput, now)}\n${code}`;
    const evalResult = ctx.evalCode(program, "snippet.js");

    // Pull __logs out regardless of success/failure.
    const logs = readLogs(ctx, maxChars);

    if (evalResult.error) {
      const err = ctx.dump(evalResult.error) as { name?: string; message?: string } | string;
      evalResult.error.dispose();
      const message = typeof err === "string" ? err : `${err.name ?? "Error"}: ${err.message ?? "unknown"}`;
      if (timedOut || /interrupted/i.test(message)) {
        return { result: undefined, logs, error: "The snippet ran past the time limit and was stopped.", limitHit: "time" };
      }
      if (/out of memory/i.test(message)) {
        return { result: undefined, logs, error: "The snippet used too much memory and was stopped.", limitHit: "memory" };
      }
      return { result: undefined, logs, error: message };
    }

    let result: unknown;
    try {
      result = ctx.dump(evalResult.value);
    } catch {
      result = "(result could not be serialised)";
    }
    evalResult.value.dispose();
    result = capValue(result, maxChars);
    return { result, logs };
  } finally {
    ctx.dispose();
    rt.dispose();
  }
}

function readLogs(ctx: ReturnType<QuickJSWASMModule["newContext"]>, maxChars: number): string[] {
  try {
    const handle = ctx.getProp(ctx.global, "__logs");
    const arr = ctx.dump(handle) as unknown;
    handle.dispose();
    if (!Array.isArray(arr)) return [];
    const out: string[] = [];
    let total = 0;
    for (const line of arr) {
      const s = String(line).slice(0, 2000);
      total += s.length;
      if (total > maxChars) {
        out.push("…(output truncated)");
        break;
      }
      out.push(s);
    }
    return out;
  } catch {
    return [];
  }
}

/** Keep a returned value from blowing up the model's context. */
function capValue(v: unknown, maxChars: number): unknown {
  let json: string;
  try {
    json = JSON.stringify(v);
  } catch {
    return "(result could not be serialised)";
  }
  if (json === undefined) return undefined;
  if (json.length <= maxChars) return v;
  return `(result too large — ${json.length} chars; log the parts you need instead)`;
}
