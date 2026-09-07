import { describe, it, expect } from "vitest";
import { runCode } from "../src/compute/run.js";

describe("runCode — the code sandbox", () => {
  it("returns the value of the last expression", async () => {
    const r = await runCode("const each = (847.5 * 1.18) / 3; Math.round(each * 100) / 100");
    expect(r.error).toBeUndefined();
    expect(r.result).toBe(333.35);
  });

  it("captures console.log in order and still returns the result", async () => {
    const r = await runCode('console.log("a", 1); console.log({ b: 2 }); "done"');
    expect(r.logs).toEqual(["a 1", '{"b":2}']);
    expect(r.result).toBe("done");
  });

  it("exposes JSON `input` as a global", async () => {
    const r = await runCode("input.reduce((a, b) => a + b, 0)", [52.4, 38.1, 25]);
    expect(r.result).toBeCloseTo(115.5);
  });

  it("exposes the current time as NOW (injectable for determinism)", async () => {
    const r = await runCode(
      'Math.ceil((new Date("2026-12-01") - new Date(NOW)) / 86400000)',
      undefined,
      { now: new Date("2026-09-07T00:00:00Z") }
    );
    expect(r.result).toBe(85);
  });

  it("reports a syntax error without throwing", async () => {
    const r = await runCode("const x = ;");
    expect(r.result).toBeUndefined();
    expect(r.error).toMatch(/SyntaxError/);
  });

  it("reports a thrown error", async () => {
    const r = await runCode('throw new Error("nope")');
    expect(r.error).toMatch(/nope/);
  });

  it("an all-declarations snippet yields no result (not a leaked preamble value)", async () => {
    const r = await runCode("const y = 5; let z = y * 2;");
    expect(r.result).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  // ---- sandbox guarantees ----

  it("has no filesystem, network, process, or clock-syscall access", async () => {
    const r = await runCode(
      '[typeof process, typeof require, typeof fetch, typeof XMLHttpRequest, typeof Deno, typeof WebSocket].join(",")'
    );
    expect(r.result).toBe("undefined,undefined,undefined,undefined,undefined,undefined");
  });

  it("stops a runaway loop at the time limit", async () => {
    const start = Date.now();
    const r = await runCode("while (true) {}", undefined, { timeoutMs: 400 });
    expect(Date.now() - start).toBeLessThan(2000);
    expect(r.limitHit).toBe("time");
    expect(r.error).toMatch(/time limit/i);
  });

  it("stops catastrophic regex backtracking (interrupt reaches the regex engine)", async () => {
    const r = await runCode('/(a+)+$/.test("a".repeat(40) + "X")', undefined, { timeoutMs: 400 });
    expect(r.limitHit).toBe("time");
  });

  it("stops an allocation bomb at the memory limit", async () => {
    const r = await runCode("const a = []; for (;;) a.push(new Array(100000).fill(1));");
    expect(r.limitHit).toBe("memory");
    expect(r.error).toMatch(/memory/i);
  });

  it("caps an oversized returned value", async () => {
    const r = await runCode('"x".repeat(200000)');
    expect(String(r.result)).toMatch(/too large/i);
  });

  it("does not leak state between calls", async () => {
    await runCode("globalThis.__leak = 123;");
    const r = await runCode('typeof globalThis.__leak');
    expect(r.result).toBe("undefined");
  });
});
