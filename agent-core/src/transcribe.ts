import { mkdirSync } from "node:fs";
import { config } from "./config.js";

// Speech-to-text for the "talk instead of type" button in both chat UIs.
// Whisper, running IN THIS PROCESS via transformers.js (onnxruntime-node) —
// Ollama does not serve ASR models, so this is a separate inference path, the
// same way OCR in fileExtract.ts is. Kept deliberately OFF the deepagents
// planner (cf. agents/extraction.ts): a transcript is a mechanical pipeline
// step, not a conversation, so it binds a single model directly.
//
// The model weights are pulled from the Hugging Face CDN on first use and
// then cached under `<dataDir>/asr-models/`; every call after that is fully
// offline. That first fetch is the one deliberate exception to "nothing
// leaves the machine" — the exact same trade-off tesseract.js's language
// data makes, flagged here and in docs/DECISIONS.md rather than hidden.

// transformers.js is a heavy import (onnxruntime-node), so it and the model
// are loaded lazily on the first /transcribe call, never at server boot.
let transcriberPromise: Promise<Transcriber> | null = null;
let loadedKey: string | null = null;

// The subset of the transformers.js ASR pipeline we call.
type Transcriber = (
  audio: Float32Array,
  opts: Record<string, unknown>
) => Promise<{ text?: string } | { text?: string }[]>;

function cacheDir(): string {
  return `${config.dataDir}/asr-models`;
}

async function getTranscriber(): Promise<Transcriber> {
  const key = `${config.asrModel}|${config.asrDtype}`;
  if (transcriberPromise && loadedKey === key) return transcriberPromise;
  loadedKey = key;
  transcriberPromise = (async () => {
    const dir = cacheDir();
    // transformers.js's Node cache writer, like tesseract.js's, will not
    // create its own directory — make it first or every call re-downloads.
    mkdirSync(dir, { recursive: true });
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = dir;
    env.allowLocalModels = true;
    const pipe = await pipeline("automatic-speech-recognition", config.asrModel, {
      dtype: config.asrDtype as never,
    });
    return pipe as unknown as Transcriber;
  })();
  try {
    return await transcriberPromise;
  } catch (err) {
    // Don't cache a failed load — a later call (model now pulled, network
    // back) should get a fresh attempt.
    transcriberPromise = null;
    loadedKey = null;
    throw err;
  }
}

/** Drop the cached pipeline so the next call rebuilds it (model changed). */
export function resetTranscriber(): void {
  transcriberPromise = null;
  loadedKey = null;
}

/** Has the ASR model been loaded successfully? Used to gate the slow test. */
export async function transcriberIsReady(): Promise<boolean> {
  try {
    await getTranscriber();
    return true;
  } catch {
    return false;
  }
}

export interface TranscriptionResult {
  text: string;
}

/**
 * Transcribe a WAV clip (any sample rate, mono or multi-channel, PCM8/16/32
 * or 32-bit float — whatever a browser MediaRecorder round-trip or Android's
 * AudioRecord produces). Returns "" for a clip too short to contain speech.
 */
export async function transcribeWav(wav: Buffer): Promise<TranscriptionResult> {
  const { pcm, sampleRate } = decodeWav(wav);
  const audio = resampleTo16k(pcm, sampleRate);
  // < ~0.2s of audio — a stray tap on the mic button, nothing to hear.
  if (audio.length < 3200) return { text: "" };
  const transcriber = await getTranscriber();
  const out = await transcriber(audio, {
    // whisper's own window is 30s; chunk longer clips so a rambling voice
    // note still transcribes fully.
    chunk_length_s: 30,
    stride_length_s: 5,
    task: "transcribe",
    ...(config.asrLanguage ? { language: config.asrLanguage } : {}),
  });
  const text = (Array.isArray(out) ? out.map((o) => o.text ?? "").join(" ") : out.text ?? "").trim();
  return { text: cleanup(text) };
}

// Whisper emits a stock phrase ("Thank you.", "you", the caption-artefact
// "Thanks for watching!") when handed near-silence. A single such phrase on
// its own is almost certainly that, not something the user said — drop it so
// it doesn't land in the chat box.
const SILENCE_HALLUCINATIONS = new Set([
  "you",
  "thank you.",
  "thank you",
  "thanks for watching!",
  "thanks for watching.",
  "bye.",
  ".",
]);
function cleanup(text: string): string {
  return SILENCE_HALLUCINATIONS.has(text.toLowerCase()) ? "" : text;
}

// ---- WAV decoding (no dependency; the browser/Android side always sends WAV
//      precisely so this stays a header parse, not an audio-codec problem) ----

interface DecodedWav {
  pcm: Float32Array;
  sampleRate: number;
}

export function decodeWav(buf: Buffer): DecodedWav {
  if (
    buf.length < 44 ||
    buf.toString("ascii", 0, 4) !== "RIFF" ||
    buf.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Not a WAV file (bad RIFF/WAVE header).");
  }

  let audioFormat = 1;
  let channels = 1;
  let sampleRate = 16000;
  let bitsPerSample = 16;
  let dataStart = -1;
  let dataLen = 0;

  // Walk the RIFF sub-chunks — "fmt " and "data" are not always adjacent
  // (a "LIST"/"fact"/"JUNK" chunk can sit between them).
  let p = 12;
  while (p + 8 <= buf.length) {
    const id = buf.toString("ascii", p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    const body = p + 8;
    if (id === "fmt " && body + 16 <= buf.length) {
      audioFormat = buf.readUInt16LE(body);
      channels = buf.readUInt16LE(body + 2) || 1;
      sampleRate = buf.readUInt32LE(body + 4) || 16000;
      bitsPerSample = buf.readUInt16LE(body + 14) || 16;
    } else if (id === "data") {
      dataStart = body;
      dataLen = Math.min(size, buf.length - body);
    }
    p = body + size + (size & 1); // chunks are word-aligned
  }
  if (dataStart < 0) throw new Error("WAV has no data chunk.");

  const isFloat = audioFormat === 3;
  const bytesPerSample = Math.max(1, bitsPerSample >> 3);
  const frames = Math.floor(dataLen / (bytesPerSample * channels));
  const mono = new Float32Array(frames);

  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const off = dataStart + (i * channels + c) * bytesPerSample;
      acc += readSample(buf, off, bitsPerSample, isFloat);
    }
    mono[i] = acc / channels;
  }
  return { pcm: mono, sampleRate };
}

function readSample(buf: Buffer, off: number, bits: number, isFloat: boolean): number {
  if (isFloat) return bits === 64 ? buf.readDoubleLE(off) : buf.readFloatLE(off);
  if (bits === 16) return buf.readInt16LE(off) / 32768;
  if (bits === 32) return buf.readInt32LE(off) / 2147483648;
  if (bits === 8) return (buf.readUInt8(off) - 128) / 128; // 8-bit WAV is unsigned
  if (bits === 24) {
    const v = buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16);
    return (v & 0x800000 ? v - 0x1000000 : v) / 8388608;
  }
  throw new Error(`Unsupported WAV bit depth: ${bits}`);
}

/** Linear-interpolation resample to 16 kHz — plenty for a speech model. */
export function resampleTo16k(pcm: Float32Array, srcRate: number): Float32Array {
  if (srcRate === 16000 || pcm.length === 0) return pcm;
  const ratio = 16000 / srcRate;
  const outLen = Math.max(1, Math.round(pcm.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    out[i] = pcm[i0] + (pcm[i1] - pcm[i0]) * (srcPos - i0);
  }
  return out;
}
