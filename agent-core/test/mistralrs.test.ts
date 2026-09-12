import { describe, it, expect } from "vitest";
import { z } from "zod";
import { tool } from "@langchain/core/tools";
import { loadNativeAddon } from "../src/mistralrs/nativeAddon.js";
import { ChatMistralRs } from "../src/mistralrs/chatModel.js";
import { ensureMistralRsLoaded, getMistralRsStatus, invalidateMistralRsModel } from "../src/mistralrs/manager.js";

// Real end-to-end tests against the embedded mistral.rs native addon
// (native/mistralrs-node/ — mistral.rs used as a Rust library, called
// in-process; NOT a spawned mistralrs-server CLI, see that crate's
// src/lib.rs). These download and load the small default model
// (unsloth/Qwen3-0.6B-GGUF, config.ts's mistralrsModelId/mistralrsGgufFile
// defaults) into THIS process on first run, and are skipped automatically
// when the native addon hasn't been built for this platform (see
// scripts/build-mistralrs-node.sh) — same self-skip shape as
// agents.integration.test.ts's live-Ollama tests, so the fast suite still
// passes on a machine/CI runner that hasn't built the native addon.
const addonAvailable = loadNativeAddon() !== null;
const maybe = addonAvailable ? describe : describe.skip;

maybe("embedded mistral.rs (native addon)", () => {
  it("loads the configured model and answers a plain chat turn", async () => {
    const model = new ChatMistralRs({ temperature: 0 });
    const result = await model.invoke("Say the word 'pong' and nothing else.");
    expect(typeof result.content).toBe("string");
  }, 120_000);

  it("calls a bound LangChain tool and returns a structured tool_calls entry", async () => {
    const model = new ChatMistralRs({ temperature: 0 });
    const getWeather = tool(async ({ place }: { place: string }) => `Weather in ${place}: sunny, 25C.`, {
      name: "get_weather",
      description: "Get the weather for a certain city.",
      schema: z.object({ place: z.string().describe("The place to get weather for.") }),
    });
    const bound = model.bindTools!([getWeather]);
    const result = await bound.invoke("What is the weather in Boston? Use the get_weather tool.");
    expect(result.tool_calls?.length ?? 0).toBeGreaterThan(0);
    expect(result.tool_calls?.[0]?.name).toBe("get_weather");
    expect(result.tool_calls?.[0]?.args).toMatchObject({ place: expect.any(String) });
  }, 120_000);

  it("getMistralRsStatus() reports ready after a load", async () => {
    invalidateMistralRsModel();
    await ensureMistralRsLoaded();
    const status = getMistralRsStatus();
    expect(status.status).toBe("ready");
  }, 120_000);
});

describe("mistral.rs status reporting", () => {
  it("getMistralRsStatus() always returns a recognized status, addon present or not", () => {
    const status = getMistralRsStatus();
    expect(["unavailable", "idle", "loading", "ready", "error"]).toContain(status.status);
  });
});
