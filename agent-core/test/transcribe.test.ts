import { describe, it, expect } from "vitest";
import { decodeWav, resampleTo16k, transcribeWav, transcriberIsReady } from "../src/transcribe.js";

// Build a minimal PCM16 WAV from Float32 samples — mirrors what the desktop
// (MediaRecorder round-trip) and Android (AudioRecord) sides send.
function makeWav(samples: Float32Array, sampleRate = 16000, channels = 1): Buffer {
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataLen = samples.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * blockAlign, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}

function tone(seconds: number, freq = 220, sampleRate = 16000): Float32Array {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i++) out[i] = 0.25 * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

describe("WAV decoding", () => {
  it("round-trips PCM16 mono samples", () => {
    const src = tone(0.05);
    const { pcm, sampleRate } = decodeWav(makeWav(src));
    expect(sampleRate).toBe(16000);
    expect(pcm.length).toBe(src.length);
    // quantisation error only
    for (let i = 0; i < src.length; i += 37) expect(Math.abs(pcm[i] - src[i])).toBeLessThan(1e-3);
  });

  it("downmixes stereo to mono", () => {
    // interleaved L/R: L = +0.5, R = -0.5 -> mono 0
    const interleaved = new Float32Array(200);
    for (let i = 0; i < 100; i++) {
      interleaved[i * 2] = 0.5;
      interleaved[i * 2 + 1] = -0.5;
    }
    const { pcm } = decodeWav(makeWav(interleaved, 16000, 2));
    expect(pcm.length).toBe(100);
    for (const s of pcm) expect(Math.abs(s)).toBeLessThan(1e-3);
  });

  it("rejects a non-WAV buffer", () => {
    expect(() => decodeWav(Buffer.from("not audio at all, just text bytes here"))).toThrow(/WAV/);
  });

  it("skips a LIST chunk sitting between fmt and data", () => {
    const base = makeWav(tone(0.02));
    // splice a 12-byte "LIST" chunk in right after the fmt chunk (offset 36)
    const list = Buffer.alloc(12);
    list.write("LIST", 0, "ascii");
    list.writeUInt32LE(4, 4);
    list.write("INFO", 8, "ascii");
    const spliced = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
    spliced.writeUInt32LE(spliced.length - 8, 4);
    const { pcm } = decodeWav(spliced);
    expect(pcm.length).toBe(Math.round(0.02 * 16000));
  });
});

describe("resampleTo16k", () => {
  it("is a no-op at 16 kHz", () => {
    const src = tone(0.01);
    expect(resampleTo16k(src, 16000)).toBe(src);
  });
  it("scales length by the rate ratio", () => {
    const src = tone(0.1, 220, 48000); // 4800 samples @ 48k
    const out = resampleTo16k(src, 48000);
    expect(out.length).toBe(1600);
  });
});

describe("transcribeWav", () => {
  it("returns empty text for a clip too short to contain speech", async () => {
    const { text } = await transcribeWav(makeWav(tone(0.05)));
    expect(text).toBe("");
  });

  // Opt-in: downloads the Whisper model (~80 MB q8) from the HF CDN on first
  // run, so it's off by default like the live-model planner tests. Set
  // FAMILY_AGENT_TEST_ASR=1 to exercise the real pipeline.
  const live = process.env.FAMILY_AGENT_TEST_ASR === "1" ? it : it.skip;
  live(
    "loads the model and transcribes without throwing",
    async () => {
      expect(await transcriberIsReady()).toBe(true);
      const { text } = await transcribeWav(makeWav(tone(2, 300)));
      expect(typeof text).toBe("string"); // a pure tone has no words — just don't crash
    },
    120_000
  );
});
