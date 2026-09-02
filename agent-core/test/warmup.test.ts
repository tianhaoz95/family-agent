import { describe, it, expect, afterEach, vi } from "vitest";
import { warmModel } from "../src/warmup.js";
import { config } from "../src/config.js";
import { PLANNER_PROMPT } from "../src/agents/index.js";

describe("warmModel", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("sends the planner prompt to Ollama /api/chat with a 1-token cap and keep_alive", async () => {
    let body: any;
    globalThis.fetch = vi.fn(async (url: any, init: any) => {
      expect(String(url)).toBe(`${config.ollamaBaseUrl}/api/chat`);
      body = JSON.parse(init.body);
      return new Response(JSON.stringify({ message: { role: "assistant", content: "" } }), { status: 200 });
    }) as typeof fetch;

    await warmModel();

    expect(body.model).toBe(config.model);
    expect(body.messages).toEqual([{ role: "system", content: PLANNER_PROMPT }]);
    expect(body.options.num_predict).toBe(1);
    expect(body.keep_alive).toBe(config.ollamaKeepAlive);
    expect(body.stream).toBe(false);
  });

  it("swallows a network error — a failed warmup never throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    await expect(warmModel()).resolves.toBeUndefined();
  });

  it("swallows a non-200 response", async () => {
    globalThis.fetch = vi.fn(async () => new Response("model not found", { status: 404 })) as typeof fetch;
    await expect(warmModel()).resolves.toBeUndefined();
  });
});
