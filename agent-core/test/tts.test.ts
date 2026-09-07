import { describe, it, expect } from "vitest";
import { plainText, encodeWav16, synthesizeSpeech, ttsIsReady } from "../src/tts.js";

describe("plainText (strip Markdown for the reader)", () => {
  it("drops emphasis, headings, list markers and link syntax", () => {
    const md = [
      "# Garlic butter pasta",
      "",
      "A **quick** dinner with _lots_ of `garlic`.",
      "",
      "1. Boil 200g spaghetti.",
      "- Melt butter.",
      "See [the recipe](https://example.com/recipe) for more.",
    ].join("\n");
    const out = plainText(md);
    expect(out).toBe(
      "Garlic butter pasta A quick dinner with lots of garlic. Boil 200g spaghetti. Melt butter. See the recipe for more."
    );
    expect(out).not.toMatch(/[*_#`[\]()]|https?:/);
  });

  it("collapses a fenced code block to a short phrase", () => {
    expect(plainText("Here:\n```\nconst x = 1;\n```\ndone")).toBe("Here: code block. done");
  });

  it("trims and collapses whitespace", () => {
    expect(plainText("  hello \n\n  world  ")).toBe("hello world");
  });
});

describe("encodeWav16", () => {
  it("writes a valid 16-bit PCM mono WAV header", () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1, 0.25]);
    const wav = encodeWav16(pcm, 24000);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(20)).toBe(1); // PCM
    expect(wav.readUInt16LE(22)).toBe(1); // mono
    expect(wav.readUInt32LE(24)).toBe(24000); // sample rate
    expect(wav.readUInt16LE(34)).toBe(16); // bits per sample
    expect(wav.toString("ascii", 36, 40)).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(pcm.length * 2);
    expect(wav.length).toBe(44 + pcm.length * 2);
    // clamps and scales
    expect(wav.readInt16LE(44 + 6)).toBe(32767); // 1.0
    expect(wav.readInt16LE(44 + 8)).toBe(-32768); // -1.0
  });
});

// Opt-in: downloads Kokoro (~86 MB q8) from the HF CDN on first run. Off by
// default like the live-model planner tests. Set FAMILY_AGENT_TEST_TTS=1.
const live = process.env.FAMILY_AGENT_TEST_TTS === "1" ? it : it.skip;
describe("synthesizeSpeech (real model)", () => {
  live(
    "loads Kokoro and returns a non-trivial 16-bit WAV",
    async () => {
      expect(await ttsIsReady()).toBe(true);
      const wav = await synthesizeSpeech("Your car registration renews on the fifteenth.");
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.readUInt16LE(20)).toBe(1); // PCM (not float)
      expect(wav.readUInt32LE(24)).toBe(24000);
      // > 1 s of audio
      expect(wav.readUInt32LE(40)).toBeGreaterThan(24000 * 2);
    },
    180_000
  );

  live("respects an unknown voice by falling back", async () => {
    const wav = await synthesizeSpeech("Hello.", "not_a_real_voice");
    expect(wav.length).toBeGreaterThan(44);
  }, 120_000);

  it("rejects text that strips to nothing", async () => {
    await expect(synthesizeSpeech("###  **  **  ")).rejects.toThrow(/nothing to read/i);
  });
});
