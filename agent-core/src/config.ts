import { homedir } from "node:os";
import { join } from "node:path";
import { readPersistedSettings } from "./settingsFile.js";
import type { UserRecord } from "./db.js";

// Local by default, cloud by explicit grant (see docs/DECISIONS.md).
// Nothing in this file reaches off-box; ollamaBaseUrl always points at
// localhost or another node on the family network, never a public host.
//
// The store lives under the user's home directory, not inside the repo/install
// tree, so it survives a reinstall or a `git clean` and isn't accidentally
// committed. Override with FAMILY_AGENT_DATA_DIR. (A dev box that still has an
// old repo-local `agent-core/data/` can point the env var at it, or just
// re-bootstrap — the setup wizard runs again against the fresh directory.)
const dataDir =
  process.env.FAMILY_AGENT_DATA_DIR ??
  join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "family-agent");

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
  ttsVoice: process.env.FAMILY_AGENT_TTS_VOICE !== undefined,
  embedModel: process.env.FAMILY_AGENT_EMBED_MODEL !== undefined,
  serverName: process.env.FAMILY_AGENT_SERVER_NAME !== undefined,
  cardsEnabled: process.env.FAMILY_AGENT_CARDS !== undefined,
  vaultEnabled: process.env.FAMILY_AGENT_VAULT !== undefined,
  autoUpdateEnabled: process.env.FAMILY_AGENT_AUTO_UPDATE !== undefined,
  // One lock for the whole web-access group (provider + URL + key) — set any of
  // the three env vars and the Settings-page controls go read-only.
  webSearchProvider:
    process.env.FAMILY_AGENT_WEB_SEARCH_PROVIDER !== undefined ||
    process.env.FAMILY_AGENT_WEB_SEARCH_URL !== undefined ||
    process.env.FAMILY_AGENT_WEB_SEARCH_API_KEY !== undefined,
} as const;

export const config = {
  port: Number(process.env.PORT ?? 4173),
  // Mutated at runtime by PUT /settings when not env-locked — read fresh.
  ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? persisted.ollamaBaseUrl ?? "http://127.0.0.1:11434",
  model: process.env.FAMILY_AGENT_MODEL ?? persisted.model ?? "gemma4:e2b",
  // How long Ollama keeps the model resident in memory after a request
  // (same knob as Ollama's own OLLAMA_KEEP_ALIVE, read here for the client
  // param). The first chat after an idle gap pays a multi-second model
  // reload once this expires, so we hold it a good while; "-1" never
  // unloads (RAM/VRAM pinned while idle), "0" unloads immediately.
  // Accepts a Go duration string or a number of seconds.
  ollamaKeepAlive: process.env.OLLAMA_KEEP_ALIVE ?? "30m",
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

  // ---- Voice output (text-to-speech) ----
  // The "read this aloud" button on the assistant's replies (and the optional
  // "auto-read" toggle, which lives client-side). Kokoro-82M via kokoro-js,
  // run in-process (Ollama can't serve TTS) — see tts.ts. Off = /speak
  // returns 403 and both clients hide the play button (read from /health).
  ttsEnabled: process.env.FAMILY_AGENT_TTS !== "0",
  // Hugging Face repo id for the TTS model. Kokoro is the sweet spot for
  // quality-per-megabyte on CPU; this is env-configurable but not in the
  // Settings UI (the *voice* is the useful knob there).
  ttsModel: process.env.FAMILY_AGENT_TTS_MODEL || "onnx-community/Kokoro-82M-v1.0-ONNX",
  // Which Kokoro voice to use. Settable from Settings (PUT /settings) and
  // persisted. af_* American female, am_* male, bf_*/bm_* British.
  ttsVoice: process.env.FAMILY_AGENT_TTS_VOICE || persisted.ttsVoice || "af_heart",
  // ONNX weight precision for the TTS model: fp32 | q8 | q4. q8 is ~86 MB.
  ttsDtype: process.env.FAMILY_AGENT_TTS_DTYPE ?? "q8",

  // ---- Semantic search (document embeddings) ----
  // Optional: an Ollama embedding model used to build a vector index over each
  // document's text, so document search can match on meaning, not just shared
  // words — "car cover renewal" then finds a file titled "Auto Insurance
  // Policy". It is layered *on top of* the FTS5 keyword + trigram-fuzzy index
  // in db.ts and merged with reciprocal-rank fusion (embeddings.ts), never a
  // replacement: if the model is unreachable, search silently falls back to
  // keyword + fuzzy. `FAMILY_AGENT_EMBED=0` turns it off entirely — nothing is
  // embedded on ingest and /documents/search is keyword+fuzzy only.
  embedEnabled: process.env.FAMILY_AGENT_EMBED !== "0",
  // The embedding model pulled into Ollama. Small + CPU-friendly by default
  // (nomic-embed-text: 768-dim, ~275 MB). Must support the /api/embed
  // endpoint. Precedence matches model/ocrModel: env var > persisted > default.
  embedModel: process.env.FAMILY_AGENT_EMBED_MODEL ?? persisted.embedModel ?? "nomic-embed-text",

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

  // ---- Scheduled routines (routines.ts) ----
  // A routine fires an agent turn on a schedule (a morning briefing, a bill
  // nudge, a weekly review). Off = no scheduler loop, the /routines endpoints
  // 404, and both clients hide the Routines screen.
  routinesEnabled: process.env.FAMILY_AGENT_ROUTINES !== "0",
  // How often the scheduler checks for due routines. The host is a laptop, not
  // a cron server — minute granularity is plenty.
  routineTickMs: Number(process.env.FAMILY_AGENT_ROUTINE_TICK_MS ?? 60_000),
  // A routine that came due more than this long ago (laptop was asleep) is too
  // stale to catch up on — it's skipped forward to its next occurrence instead.
  routineCatchUpGraceMs: Number(process.env.FAMILY_AGENT_ROUTINE_CATCHUP_MS ?? 6 * 60 * 60_000),

  // ---- Web access (web/*, agents/webTools.ts) ----
  // The deliberate, bounded exception to "nothing leaves the machine" (see
  // docs/DECISIONS.md → "Web access"): a `research-agent` that can search the
  // web and read a page. OFF unless an admin picks a search provider. Every
  // request is funnelled through src/web/fetch.ts (SSRF-guarded) and logged.
  //   searxng — self-hosted metasearch (set FAMILY_AGENT_WEB_SEARCH_URL)
  //   tavily | brave — an API (set FAMILY_AGENT_WEB_SEARCH_API_KEY)
  //   ddg — DuckDuckGo lite HTML, no key, best-effort
  //   none (default) — the whole capability is off
  // Precedence: env var > persisted (desktop Settings → "Internet access") >
  // "none". Mutated at runtime by PUT /settings when not env-locked.
  webSearchProvider: (process.env.FAMILY_AGENT_WEB_SEARCH_PROVIDER ??
    persisted.webSearchProvider ??
    "none") as "searxng" | "tavily" | "brave" | "ddg" | "none",
  webSearchUrl: process.env.FAMILY_AGENT_WEB_SEARCH_URL ?? persisted.webSearchUrl ?? "",
  webSearchApiKey: process.env.FAMILY_AGENT_WEB_SEARCH_API_KEY ?? persisted.webSearchApiKey ?? "",
  // Optional domain guard rails for open_page (comma-separated, e.g.
  // "wikipedia.org,*.gov"). An allow-list, when non-empty, is exclusive.
  webAllowDomains: (process.env.FAMILY_AGENT_WEB_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  webDenyDomains: (process.env.FAMILY_AGENT_WEB_DENY ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  webFetchTimeoutMs: Number(process.env.FAMILY_AGENT_WEB_TIMEOUT_MS ?? 15_000),
  webFetchMaxBytes: Number(process.env.FAMILY_AGENT_WEB_MAX_BYTES ?? 2_000_000),
  webFetchMaxChars: Number(process.env.FAMILY_AGENT_WEB_MAX_CHARS ?? 12_000),

  // ---- Shell / file-processing access (shell/*, agents/workshopTools.ts) ----
  // A `workshop-agent` that runs allow-listed CLI tools (ffmpeg, qpdf, jq, …)
  // over a per-user file workspace, inside a bubblewrap sandbox with NO
  // network. OFF unless FAMILY_AGENT_SHELL=1 AND bubblewrap is installed.
  shellEnabled: process.env.FAMILY_AGENT_SHELL === "1",
  // Adds an unrestricted `run_shell` (arbitrary bash, still no network, still
  // workspace-scoped, still resource-capped). Admin accounts only.
  shellUnrestricted: process.env.FAMILY_AGENT_SHELL_UNRESTRICTED === "1",
  // Extra binaries to allow beyond the built-in curated set (comma-separated).
  shellAllow: (process.env.FAMILY_AGENT_SHELL_ALLOW ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  shellTimeoutMs: Number(process.env.FAMILY_AGENT_SHELL_TIMEOUT_MS ?? 60_000),
  shellMaxOutputBytes: Number(process.env.FAMILY_AGENT_SHELL_MAX_OUTPUT ?? 20_000),
  workspaceMaxBytes: Number(process.env.FAMILY_AGENT_WORKSPACE_MAX_BYTES ?? 512 * 1024 * 1024),
  bwrapPath: process.env.FAMILY_AGENT_BWRAP_PATH ?? "",

  // ---- Code sandbox (compute/run.ts, agents/computeTools.ts) ----
  // A stateless `run_code` tool — the planner runs a JS snippet for
  // arithmetic / date math / small data analysis (a 2B model does those wrong
  // in its head). QuickJS-in-wasm: no syscalls at all, so this is a pure
  // function and safe to leave ON by default (unlike web/shell it changes no
  // security posture). FAMILY_AGENT_COMPUTE=0 disables it.
  computeEnabled: process.env.FAMILY_AGENT_COMPUTE !== "0",
  computeTimeoutMs: Number(process.env.FAMILY_AGENT_COMPUTE_TIMEOUT_MS ?? 3_000),
  computeMemoryBytes: Number(process.env.FAMILY_AGENT_COMPUTE_MEMORY_BYTES ?? 64 * 1024 * 1024),
  computeMaxOutputChars: Number(process.env.FAMILY_AGENT_COMPUTE_MAX_OUTPUT ?? 10_000),

  // ---- AI-generated full-page artifacts (artifacts/*, agents/artifactTools.ts) ----
  // `render_artifact` — the assistant writes a whole HTML page to explain
  // something, browsable in an Artifacts tab. Same sealed opaque-origin sandbox
  // as render_card (no network, no app access), so it adds no trust boundary
  // the card feature didn't already establish → on by default, env-only.
  // FAMILY_AGENT_ARTIFACTS=0 disables it.
  artifactsEnabled: process.env.FAMILY_AGENT_ARTIFACTS !== "0",

  // ---- Skills (skills/*, agents/skillTools.ts) ----
  // A skill is a folder the family adds under <dataDir>/skills/<name>/ with a
  // SKILL.md (front-matter + instructions) and optional scripts/. The planner
  // sees only names + descriptions until it calls use_skill, which loads the
  // full instructions for the rest of the turn (progressive disclosure — keeps
  // a small model's context lean). Just prompt text + sandboxed scripts, so
  // it's ON by default. FAMILY_AGENT_SKILLS=0 disables it.
  skillsEnabled: process.env.FAMILY_AGENT_SKILLS !== "0",
  skillScriptTimeoutMs: Number(process.env.FAMILY_AGENT_SKILL_SCRIPT_TIMEOUT_MS ?? 30_000),

  // ---- MCP connections (mcp/*, agents/mcpTools.ts) ----
  // Connect the family agent to external Model Context Protocol servers (a
  // calendar, a company knowledge base, home automation, …). OFF unless
  // FAMILY_AGENT_MCP=1. Each server is configured in <dataDir>/mcp.json (or
  // seeded from FAMILY_AGENT_MCP_SERVERS, a JSON array). A `connections-agent`
  // subagent enumerates and calls their tools — never the planner directly, so
  // a server with 30 tools doesn't blow the small model's context. Results are
  // wrapped untrusted, every call logged. HTTP transport is guarded like the
  // web capability; stdio servers run inside the bubblewrap sandbox.
  mcpEnabled: process.env.FAMILY_AGENT_MCP === "1",
  mcpServersSeed: process.env.FAMILY_AGENT_MCP_SERVERS ?? "",
  mcpCallTimeoutMs: Number(process.env.FAMILY_AGENT_MCP_TIMEOUT_MS ?? 30_000),
  mcpMaxResultChars: Number(process.env.FAMILY_AGENT_MCP_MAX_RESULT ?? 8_000),

  // ---- password vault ----
  // A per-user encrypted store for passwords + TOTP seeds (optionally shared
  // across the family) that the local assistant can read out on request. OFF
  // by default — it holds the family's most sensitive data. An admin-only
  // desktop Settings toggle, same as cardsEnabled: FAMILY_AGENT_VAULT=1/0
  // pins it (env-locked, read-only in the UI) when set; otherwise the
  // persisted setting from PUT /settings applies. The vault's own HTTP
  // routes all gate on this per-request (see vaultGuard in server.ts), not
  // at server startup, so flipping it takes effect immediately — no restart.
  vaultEnabled:
    process.env.FAMILY_AGENT_VAULT !== undefined
      ? process.env.FAMILY_AGENT_VAULT === "1"
      : persisted.vaultEnabled ?? false,
  // Whether the assistant may read vault secrets via tool calls (the "/vault"
  // forced chat turn). Separate switch so a family can keep the vault UI
  // without giving the AI access. Only consulted when vaultEnabled is on;
  // defaults on there. FAMILY_AGENT_VAULT_AI=0 turns off just the AI path.
  vaultAiEnabled: process.env.FAMILY_AGENT_VAULT_AI !== "0",
  // How long a vault stays unlocked in memory without use before it re-locks.
  vaultIdleMs: Number(process.env.FAMILY_AGENT_VAULT_IDLE_MS ?? 15 * 60_000),

  // ---- AI-generated HTML cards (render_card) ----
  // The assistant can answer with a small self-contained HTML/JS snippet the
  // UI embeds inline (a chart, a checklist, a diagram). Generated code is less
  // stable than text, so this is the first boolean machine setting an admin
  // can flip from the desktop Settings page. Default ON; env var
  // `FAMILY_AGENT_CARDS=0` forces it off (and env-locks the toggle). When off,
  // `render_card` is not wired into any agent. Precedence: env > persisted > default.
  cardsEnabled:
    process.env.FAMILY_AGENT_CARDS !== undefined
      ? process.env.FAMILY_AGENT_CARDS !== "0"
      : persisted.cardsEnabled ?? true,

  // ---- desktop auto-update ----
  // Off by default (see desktop/src/main.ts's own comment: an update
  // restarts the shared server everyone on the LAN is talking to, so it's
  // never applied silently unless an admin opts in here). When on, the
  // desktop app's periodic background check installs and restarts on its
  // own instead of just showing a "Version X available" prompt. This flag
  // only means anything to the desktop frontend — agent-core itself has no
  // updater — same admin-toggle shape as cardsEnabled/vaultEnabled.
  // FAMILY_AGENT_AUTO_UPDATE=1/0 pins it; otherwise the persisted setting
  // from PUT /settings applies.
  autoUpdateEnabled:
    process.env.FAMILY_AGENT_AUTO_UPDATE !== undefined
      ? process.env.FAMILY_AGENT_AUTO_UPDATE === "1"
      : persisted.autoUpdateEnabled ?? false,
};

/** The watched folder for one user — their own override, or the derived default. */
export function userInboxDir(user: Pick<UserRecord, "id" | "inboxDir">): string {
  return user.inboxDir ?? `${config.inboxBase}/${user.id}`;
}

export function toolsDir(): string {
  return `${config.dataDir}/tools`;
}

/** Per-user scratch dir the workshop agent's CLI tools read and write. */
export function workspaceDir(userId: string): string {
  return `${config.dataDir}/workspace/${userId}`;
}

/** Where family skills live: one folder per skill, each with a SKILL.md. */
export function skillsDir(): string {
  return `${config.dataDir}/skills`;
}

/** Config file for external MCP servers the agent connects to. */
export function mcpConfigPath(): string {
  return `${config.dataDir}/mcp.json`;
}

/** Where an uploaded document's original file is kept so it can be previewed
 *  later (PDF viewer / image). One subdir per user; the file is named by the
 *  document id. Watched-folder documents keep their own on-disk path instead. */
export function documentsDir(): string {
  return `${config.dataDir}/documents`;
}

export function dbPath(): string {
  return `${config.dataDir}/family-agent.db`;
}
