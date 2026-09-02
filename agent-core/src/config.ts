import { readPersistedSettings } from "./settingsFile.js";
import type { UserRecord } from "./db.js";

// Local by default, cloud by explicit grant (see docs/DECISIONS.md).
// Nothing in this file reaches off-box; ollamaBaseUrl always points at
// localhost or another node on the family network, never a public host.
const dataDir = process.env.FAMILY_AGENT_DATA_DIR ?? new URL("../data", import.meta.url).pathname;

// Precedence for the live-editable settings: explicit env var > persisted
// setting (from the desktop Settings page, PUT /settings) > derived/default.
// The env var always wins so an operator's explicit override can't be
// silently shadowed by a value saved from the UI on a previous run — and
// when an env var is set, that setting is locked (the UI shows it read-only
// and PUT /settings refuses to change it). `envLocked` carries that state.
const persisted = readPersistedSettings(dataDir);

export const envLocked = {
  model: process.env.FAMILY_AGENT_MODEL !== undefined,
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL !== undefined,
  // Pins the inbox *base* dir — each user's watched folder is then
  // `<base>/<userId>` and can't be individually overridden.
  inboxDir: process.env.FAMILY_AGENT_INBOX_DIR !== undefined,
  ocrModel: process.env.FAMILY_AGENT_OCR_MODEL !== undefined,
  asrModel: process.env.FAMILY_AGENT_ASR_MODEL !== undefined,
  serverName: process.env.FAMILY_AGENT_SERVER_NAME !== undefined,
} as const;

export const config = {
  port: Number(process.env.PORT ?? 4173),
  // Mutated at runtime by PUT /settings when not env-locked — read fresh.
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? persisted.ollamaBaseUrl ?? "http://127.0.0.1:11434",
  model: process.env.FAMILY_AGENT_MODEL ?? persisted.model ?? "gemma4:e2b",
  dataDir,
  // Display name for this master node, shown on the login screen and
  // advertised over mDNS so a phone can pick the right family server.
  serverName: process.env.FAMILY_AGENT_SERVER_NAME ?? persisted.serverName ?? "Family Agent",
  // The "drop a file in a watched folder" story from the architecture notes,
  // now per-user: each account watches `<inboxBase>/<userId>` unless it set
  // its own folder (users.inbox_dir). Derived from dataDir so overriding
  // FAMILY_AGENT_DATA_DIR moves it too, unless FAMILY_AGENT_INBOX_DIR is set.
  inboxBase: process.env.FAMILY_AGENT_INBOX_DIR ?? `${dataDir}/inbox`,
  // Optional OCR upgrade: an Ollama vision model (e.g. "glm-ocr:latest") used
  // for scans/photos/image-only PDFs instead of the built-in tesseract.js.
  // Empty string = built-in engine. Mutated at runtime by PUT /settings.
  ocrModel: process.env.FAMILY_AGENT_OCR_MODEL ?? persisted.ocrModel ?? "",
  // Whole-request budget for the vision-model OCR path before it gives up and
  // falls back to tesseract. Vision models are GPU-friendly and CPU-brutal —
  // on a CPU-only box a single page can take minutes, so this bounds how long
  // an upload blocks. Bump it on a machine with a GPU.
  ocrModelTimeoutMs: Number(process.env.FAMILY_AGENT_OCR_TIMEOUT_MS ?? 180_000),

  // ---- Voice input (speech-to-text) ----
  // The "hold to talk" button in both chat composers. Whisper via
  // transformers.js, run in-process (Ollama can't serve ASR) — see
  // transcribe.ts. Off = /transcribe returns 403 and both clients hide the
  // mic button (they read this from /health).
  asrEnabled: process.env.FAMILY_AGENT_ASR !== "0",
  // Hugging Face repo id for the ASR model — NOT an Ollama model, so it's not
  // validated against `ollama list` the way `model`/`ocrModel` are. Empty
  // falls back to the default. Bigger = better + slower: whisper-tiny(.en) is
  // fastest, whisper-small the most accurate that's still reasonable on CPU.
  asrModel: process.env.FAMILY_AGENT_ASR_MODEL || persisted.asrModel || "Xenova/whisper-base",
  // Force the transcription language (ISO code, e.g. "en"); empty = whisper
  // autodetects. Worth pinning for a single-language household — autodetect
  // on a short clip occasionally guesses wrong.
  asrLanguage: process.env.FAMILY_AGENT_ASR_LANGUAGE ?? "",
  // ONNX weight precision for the ASR model: fp32 | fp16 | q8 | q4. q8 roughly
  // halves the download and speeds inference for a small accuracy cost.
  asrDtype: process.env.FAMILY_AGENT_ASR_DTYPE ?? "q8",

  // Advertise this node on the LAN via mDNS/DNS-SD so the Android app can
  // find it without a hand-typed address. Off = manual URL entry only.
  mdnsEnabled: process.env.FAMILY_AGENT_MDNS !== "0",

  // ---- Builder tools (agents/builder + tools/*) ----
  // The agent can generate small self-contained web tools to help finish a
  // task. They're served from a SEPARATE HTTP server on this port so a
  // tool's page can never reach agent-core's own routes (tasks, documents,
  // Ollama) — see tools/server.ts and the CSP it sends.
  toolsPort: Number(process.env.FAMILY_AGENT_TOOLS_PORT ?? 4174),
  // Master switch. Off = no tools server, no builder subagent, endpoints 404.
  toolsEnabled: process.env.FAMILY_AGENT_TOOLS !== "0",
  // Path to the `deno` binary used to run a tool's optional sandboxed
  // backend. Empty until resolved at startup (which auto-detects PATH and
  // .toolchains/deno). "server"-kind tools need it; "static" tools don't.
  denoPath: process.env.FAMILY_AGENT_DENO_PATH ?? "",
  // A generated tool's backend process is killed if it runs longer than this
  // without being opened, and always capped at this since last activity.
  toolIdleTimeoutMs: Number(process.env.FAMILY_AGENT_TOOL_IDLE_MS ?? 30 * 60_000),
};

/** The watched folder for one user — their own override, or the derived default. */
export function userInboxDir(user: Pick<UserRecord, "id" | "inboxDir">): string {
  return user.inboxDir ?? `${config.inboxBase}/${user.id}`;
}

export function toolsDir(): string {
  return `${config.dataDir}/tools`;
}

export function dbPath(): string {
  return `${config.dataDir}/family-agent.db`;
}
