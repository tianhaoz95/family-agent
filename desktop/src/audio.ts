// Microphone capture for the chat composer's voice-input button.
//
// Uses the Web Audio API directly (getUserMedia -> AudioContext ->
// ScriptProcessorNode) rather than MediaRecorder: MediaRecorder is not
// implemented in the WebKitGTK webview the Linux desktop build runs in
// ("MediaRecorder is unsupported on this platform"). Capturing raw PCM and
// encoding the WAV ourselves also means we hand agent-core's /transcribe
// exactly the 16 kHz mono WAV it wants, with no codec in between (see
// agent-core/src/transcribe.ts).

export interface Recording {
  /** Stop, and resolve with a 16 kHz mono WAV blob. */
  stop(): Promise<Blob>;
  /** Abandon the recording and release the mic. */
  cancel(): void;
}

const TARGET_RATE = 16000;

/**
 * @param onLevel called on every audio-process tick with a 0..1 loudness
 *   estimate (RMS, lightly smoothed) — drives the push-to-talk waveform.
 */
export async function startRecording(onLevel?: (level: number) => void): Promise<Recording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const AudioCtx: typeof AudioContext =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  // A resume() is needed if the context starts suspended (autoplay policy).
  if (ctx.state === "suspended") await ctx.resume().catch(() => {});

  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(4096, 1, 1);
  // Route the processor to the destination through a muted gain node — some
  // engines only run onaudioprocess while the node is connected downstream,
  // but we must not actually play the mic back through the speakers.
  const mute = ctx.createGain();
  mute.gain.value = 0;

  const chunks: Float32Array[] = [];
  let capturing = true;
  let smoothed = 0;
  processor.onaudioprocess = (e) => {
    if (!capturing) return;
    // getChannelData returns a view that's reused between callbacks — copy it.
    const frame = new Float32Array(e.inputBuffer.getChannelData(0));
    chunks.push(frame);
    if (onLevel) {
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      const rms = Math.sqrt(sum / frame.length);
      // Attack fast, release slow — reads as a lively but not jittery meter.
      smoothed = rms > smoothed ? rms * 0.6 + smoothed * 0.4 : rms * 0.2 + smoothed * 0.8;
      onLevel(Math.min(1, smoothed * 6));
    }
  };

  source.connect(processor);
  processor.connect(mute);
  mute.connect(ctx.destination);

  const inputRate = ctx.sampleRate;

  const teardown = () => {
    capturing = false;
    processor.onaudioprocess = null;
    try {
      source.disconnect();
      processor.disconnect();
      mute.disconnect();
    } catch {
      /* already torn down */
    }
    stream.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  return {
    stop: async () => {
      capturing = false;
      const pcm = merge(chunks);
      teardown();
      return pcm16Wav(resampleTo16k(pcm, inputRate), TARGET_RATE);
    },
    cancel: teardown,
  };
}

function merge(chunks: Float32Array[]): Float32Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// Linear-interpolation resample — plenty for a speech model, and matches the
// safety-net resampler on the agent-core side.
function resampleTo16k(pcm: Float32Array, srcRate: number): Float32Array {
  if (srcRate === TARGET_RATE || pcm.length === 0) return pcm;
  const ratio = TARGET_RATE / srcRate;
  const outLen = Math.max(1, Math.round(pcm.length * ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i / ratio;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, pcm.length - 1);
    out[i] = pcm[i0] + (pcm[i1] - pcm[i0]) * (pos - i0);
  }
  return out;
}

function pcm16Wav(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
