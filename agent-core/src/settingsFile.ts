import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// The MACHINE-WIDE settings an admin can change from the app itself (via the
// desktop Settings page, PUT /settings) rather than an env var + restart.
// Small and file-based on purpose — one JSON object, no migration story
// needed. Per-user settings (each user's watched folder) live on the `users`
// table instead, not here.
export interface PersistedSettings {
  /**
   * Ollama vision model to use for OCR (scans, photos, image-only PDFs).
   * Empty / unset means the built-in tesseract.js engine. See fileExtract.ts.
   */
  ocrModel?: string;
  /** Hugging Face repo id for the speech-to-text (voice input) model. See transcribe.ts. */
  asrModel?: string;
  /** The chat/planner model name pulled into Ollama. */
  model?: string;
  /** Base URL of the Ollama instance (localhost, or a tailnet node). */
  ollamaBaseUrl?: string;
  /** Display name for this master node — shown on login and in LAN discovery. */
  serverName?: string;
}

const STRING_KEYS: (keyof PersistedSettings)[] = ["ocrModel", "asrModel", "model", "ollamaBaseUrl", "serverName"];

function settingsPath(dataDir: string): string {
  return `${dataDir}/settings.json`;
}

export function readPersistedSettings(dataDir: string): PersistedSettings {
  try {
    const parsed = JSON.parse(readFileSync(settingsPath(dataDir), "utf8")) as Record<string, unknown>;
    const out: PersistedSettings = {};
    for (const key of STRING_KEYS) {
      if (typeof parsed[key] === "string") out[key] = parsed[key] as string;
    }
    return out;
  } catch {
    return {};
  }
}

// Merge `patch` into whatever is already on disk — a write that only touches
// one field must not drop the others. `undefined` fields in `patch` mean
// "leave unchanged" (an empty string, by contrast, is a real saved value).
export function persistSettings(dataDir: string, patch: PersistedSettings): PersistedSettings {
  mkdirSync(dataDir, { recursive: true });
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined)
  ) as PersistedSettings;
  const next: PersistedSettings = { ...readPersistedSettings(dataDir), ...defined };
  writeFileSync(settingsPath(dataDir), JSON.stringify(next, null, 2));
  return next;
}
