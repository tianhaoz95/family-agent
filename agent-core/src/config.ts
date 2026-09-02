import { readPersistedSettings } from "./settingsFile.js";

// Local by default, cloud by explicit grant (see docs/DECISIONS.md).
// Nothing in this file reaches off-box; ollamaBaseUrl always points at
// localhost or another node on the family tailnet, never a public host.
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
  inboxDir: process.env.FAMILY_AGENT_INBOX_DIR !== undefined,
  ocrModel: process.env.FAMILY_AGENT_OCR_MODEL !== undefined,
} as const;

export const config = {
  port: Number(process.env.PORT ?? 4173),
  // Mutated at runtime by PUT /settings when not env-locked — read fresh.
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? persisted.ollamaBaseUrl ?? "http://127.0.0.1:11434",
  model: process.env.FAMILY_AGENT_MODEL ?? persisted.model ?? "gemma4:e2b",
  dataDir,
  // The "drop a file in a watched folder" story from the architecture notes.
  // Derived from dataDir (not hardcoded) so overriding FAMILY_AGENT_DATA_DIR
  // moves both together, unless FAMILY_AGENT_INBOX_DIR is set explicitly. A
  // real deployment would point this at the NAS/cloud-mounted directory
  // instead of anywhere under dataDir. Mutated at runtime by PUT /settings.
  inboxDir: process.env.FAMILY_AGENT_INBOX_DIR ?? persisted.inboxDir ?? `${dataDir}/inbox`,
  // Optional OCR upgrade: an Ollama vision model (e.g. "glm-ocr:latest") used
  // for scans/photos/image-only PDFs instead of the built-in tesseract.js.
  // Empty string = built-in engine. Mutated at runtime by PUT /settings.
  ocrModel: process.env.FAMILY_AGENT_OCR_MODEL ?? persisted.ocrModel ?? "",
  // Whole-request budget for the vision-model OCR path before it gives up and
  // falls back to tesseract. Vision models are GPU-friendly and CPU-brutal —
  // on a CPU-only box a single page can take minutes, so this bounds how long
  // an upload blocks. Bump it on a machine with a GPU.
  ocrModelTimeoutMs: Number(process.env.FAMILY_AGENT_OCR_TIMEOUT_MS ?? 180_000),

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

export function toolsDir(): string {
  return `${config.dataDir}/tools`;
}

export function dbPath(): string {
  return `${config.dataDir}/family-agent.db`;
}
