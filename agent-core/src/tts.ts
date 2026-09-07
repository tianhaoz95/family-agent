import { mkdirSync } from "node:fs";
import { config } from "./config.js";

// Text-to-speech for the "read this aloud" button on the assistant's replies.
// Kokoro-82M via kokoro-js (transformers.js / onnxruntime-node), run IN THIS
// PROCESS — Ollama serves neither ASR nor TTS, so this is a separate inference
// path, the exact same shape as transcribe.ts (and OCR in fileExtract.ts).
// Kept OFF the deepagents planner (cf. agents/extraction.ts): reading text
// aloud is a mechanical pipeline step, not a conversation.
//
// The model weights (~86 MB at q8) are pulled from the Hugging Face CDN on the
// first /speak call and then cached under `<dataDir>/tts-models/`; every call
// after that is fully offline. That first fetch is the same deliberate
// exception to "nothing leaves the machine" that Whisper and tesseract's
// language data make — flagged here and in docs/DECISIONS.md, not hidden.
//
// The phonemiser (kokoro-js's `phonemizer` dep) is a WASM eSpeak-NG build — no
// native binary, so this stays a plain `npm install`.

// kokoro-js is a heavy import (pulls transformers.js / onnxruntime-node), so it
// and the model load lazily on the first /speak call, never at server boot.
interface KokoroAudio {
  audio: Float32Array;
  sampling_rate: number;
}
interface Kokoro {
  generate(text: string, opts: { voice: string }): Promise<KokoroAudio>;
  voices: Record<string, unknown>;
}

let ttsPromise: Promise<Kokoro> | null = null;
let loadedKey: string | null = null;

function cacheDir(): string {
  return `${config.dataDir}/tts-models`;
}

async function getKokoro(): Promise<Kokoro> {
  const key = `${config.ttsModel}|${config.ttsDtype}`;
  if (ttsPromise && loadedKey === key) return ttsPromise;
  loadedKey = key;
  ttsPromise = (async () => {
    const dir = cacheDir();
    // transformers.js's Node cache writer won't create its own directory —
    // make it first or every call re-downloads (same gotcha as transcribe.ts).
    mkdirSync(dir, { recursive: true });
    const { env } = await import("@huggingface/transformers");
    env.cacheDir = dir;
    env.allowLocalModels = true;
    const { KokoroTTS } = await import("kokoro-js");
    const tts = await KokoroTTS.from_pretrained(config.ttsModel, {
      dtype: config.ttsDtype as never,
      device: "cpu",
    });
    return tts as unknown as Kokoro;
  })();
  try {
    return await ttsPromise;
  } catch (err) {
    // Don't cache a failed load — a later call (model now pulled, network
    // back) should get a fresh attempt.
    ttsPromise = null;
    loadedKey = null;
    throw err;
  }
}

/** Drop the cached model so the next call rebuilds it (voice model changed). */
export function resetTts(): void {
  ttsPromise = null;
  loadedKey = null;
}

/** Has the TTS model been loaded successfully? Gates the slow test. */
export async function ttsIsReady(): Promise<boolean> {
  try {
    await getKokoro();
    return true;
  } catch {
    return false;
  }
}

/** The voice ids the loaded model exposes (best-effort — [] if not loaded). */
export async function listVoices(): Promise<string[]> {
  try {
    const tts = await getKokoro();
    return Object.keys(tts.voices ?? {}).sort();
  } catch {
    return [];
  }
}

// A runaway reply shouldn't lock the CPU for ten minutes. ~2000 chars is
// roughly 2–3 minutes of speech; longer replies read up to here and stop.
const MAX_CHARS = 2000;

/** Strip Markdown so the model reads prose, not "asterisk asterisk bold". */
export function plainText(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " code block. ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/^>\s?/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Synthesise `text` (Markdown or plain) to a 16-bit PCM mono WAV at the model's
 * native 24 kHz. 16-bit PCM rather than kokoro-js's own 32-bit float WAV so it
 * plays everywhere (Android MediaPlayer chokes on float WAV on older releases).
 */
export async function synthesizeSpeech(text: string, voice?: string): Promise<Buffer> {
  const clean = plainText(text).slice(0, MAX_CHARS);
  if (!clean) throw new Error("Nothing to read aloud.");
  const tts = await getKokoro();
  const wanted = voice?.trim() || config.ttsVoice;
  const v = tts.voices?.[wanted] !== undefined ? wanted : config.ttsVoice;
  const out = await tts.generate(clean, { voice: v });
  return encodeWav16(out.audio, out.sampling_rate);
}

/** Float32 PCM in [-1, 1] → a standalone 16-bit PCM WAV (mono). */
export function encodeWav16(pcm: Float32Array, sampleRate: number): Buffer {
  const bytesPerSample = 2;
  const dataLen = pcm.length * bytesPerSample;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16); // PCM fmt chunk size
  buf.writeUInt16LE(1, 20); // audioFormat 1 = PCM
  buf.writeUInt16LE(1, 22); // channels
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * bytesPerSample, 28); // byte rate
  buf.writeUInt16LE(bytesPerSample, 32); // block align
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataLen, 40);
  let off = 44;
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.max(-1, Math.min(1, pcm[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), off);
    off += 2;
  }
  return buf;
}
