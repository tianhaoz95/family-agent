# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first agentic app for family document, schedule, and task organization: a Node/TS
backend (`agent-core`) running a deepagents-based planner behind a local HTTP API, a Tauri
desktop app, and a native Android companion app. Everything runs on the user's own machine —
inference goes through a local Ollama instance, nothing is sent to a cloud API. Read
`docs/STATUS.md` first if you haven't touched this repo before; `docs/DECISIONS.md` explains
every non-obvious choice below (and *why*), `docs/BUILD_LOG.md` has the chronological blow-by-blow
of what broke and how it was fixed.

## Prerequisites

- Ollama running locally with the model pulled: `ollama serve &` then `ollama pull gemma4:e2b`
  (default model; override with `FAMILY_AGENT_MODEL`). The model **must** support tool-calling in
  Ollama's serving layer — that's a property of the specific model, not something deepagents
  provides. Not every model does; confirmed failures and the reasoning are in `docs/DECISIONS.md`.
- Android toolchain (JDK 17, Android SDK) lives in `.toolchains/` at the repo root, gitignored and
  machine-local — see `docs/BUILD_LOG.md`'s "android" section if it's missing and needs
  reinstalling.

## Commands

Easiest path — launcher scripts that do their own readiness checks:
```bash
./scripts/start-desktop.sh   # checks Ollama/model, launches the Tauri app
./scripts/start-android.sh   # detects/boots an emulator, builds, installs, launches the app
                              # (set FAMILY_AGENT_EMULATOR_HEADLESS=1 for a headless boot)
```

**agent-core** (`cd agent-core`):
```bash
npm run dev              # tsx watch — live reload
npm run build             # tsc -p tsconfig.json -> dist/
npm test                  # vitest run — see "Test tiers" below
npx vitest run test/db.test.ts        # single file
npx vitest run -t "creates a task"    # single test by name
npx tsc -p tsconfig.json --noEmit     # typecheck only
```

**desktop** (`cd desktop`):
```bash
npm run tauri:dev         # dev mode with hot reload (spawns agent-core itself)
npm run tauri:build       # release bundle -> src-tauri/target/release/bundle/
npm run typecheck         # tsc --noEmit
npm test                  # vitest run (api.ts client tests, mocked fetch)
```

**android** (`cd android`, needs `JAVA_HOME`/`ANDROID_HOME` pointed at `../.toolchains/`):
```bash
export JAVA_HOME=$(pwd)/../.toolchains/jdk17
export ANDROID_HOME=$(pwd)/../.toolchains/android-sdk
./gradlew testDebugUnitTest             # unit tests (FamilyAgentApi against MockWebServer)
./gradlew testDebugUnitTest --tests "*.FamilyAgentApiTest.health parses model and status"
./gradlew assembleDebug                 # -> app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug                  # build + install on a connected device/emulator
```

From the repo root, `npm test` runs agent-core's suite then desktop's.

### Test tiers in agent-core — know this before touching agent code

`test/agents.integration.test.ts` makes real calls to the locally running Ollama model and is
**slow** (a full planner turn has taken up to ~110s on modest hardware) and **skips itself
automatically** if the configured model isn't reachable (`modelIsReady()` check at the top of the
file) — so `npm test` still passes green in an environment without Ollama set up, just with fewer
tests run. Everything else (`db.test.ts`, `documentTools.test.ts`, `inboxWatcher.test.ts`,
`askFamilyAgent.test.ts`, most of `server.routes.test.ts`) is fast and uses no live model. When
changing agent prompts or tool wiring, run the integration tests — small local models are
unreliable enough that bugs here routinely don't show up in the fast tests (see the "planner
confused documents with its own filesystem" and "task-agent refused a bare action phrase"
write-ups in `docs/DECISIONS.md` for two real examples caught only by live-model testing).

## Architecture

Three independent apps sharing one HTTP contract, no shared code between them (types are
duplicated by hand in each client — `desktop/src/api.ts` and
`android/.../data/ApiModels.kt` — rather than via a shared package).

```
agent-core (Node/TS, port 4173)  <--HTTP-->  desktop (Tauri, spawns agent-core as a sidecar)
        ^                                     android (Kotlin/Compose, manual server URL in Settings)
        |
     Ollama (local, port 11434)
```

**agent-core** (`agent-core/src/`):
- `server.ts` — Fastify app. `buildServer(store, onInboxDirChange?)` is the testable factory
  (used directly by tests via `app.inject`); `main()` wires it to a real port, starts the inbox
  watcher, and supplies the callback that lets `PUT /settings` restart the watcher live. CORS is
  fully open (`origin: true`) deliberately — see `docs/DECISIONS.md` for why that's not a gap.
  **`methods` must be listed explicitly** (`["GET", "POST", "PATCH", "PUT"]`) — `@fastify/cors`
  defaults to `GET,HEAD,POST` only, which silently broke `PATCH`/`PUT` from the real desktop
  webview for a while (curl and `app.inject()` both bypass real CORS preflight, so neither caught
  it). If you add a route using a new HTTP method, add it here too, or it'll work in every test
  and every curl check while being broken in the actual browser.
- `fileExtract.ts` — `extractText(filename, buffer)` dispatches by extension: `.txt`/`.md` as
  plain utf8, `.pdf` via `pdf-parse` (text layer if present, else OCR the embedded page images —
  scanned PDFs work), images (`.jpg`/`.jpeg`/`.png`/`.webp`) via OCR. OCR is `tesseract.js` by
  default, or an Ollama vision model when `config.ocrModel` is set (`FAMILY_AGENT_OCR_MODEL` /
  Settings), falling back to tesseract on any failure. Two non-obvious things here: (1) OCR's
  language-model cache path is set explicitly to `<dataDir>/tessdata/` and the directory is
  `mkdir`'d first — tesseract.js's Node cache writer is a plain `fs.writeFile` that silently fails
  if the dir doesn't exist, so without this every OCR call re-downloads from the CDN instead of
  hitting a local cache. (2) image bytes are magic-byte-checked before being handed to
  tesseract.js (`looksLikeImage`) — feeding it a file that's merely *named* `.jpg` but isn't
  really an image can crash the whole process from inside the worker thread, not just reject one
  promise; a normal try/catch around `recognize()` doesn't stop that.
- `settingsFile.ts` — persists the settings the desktop Settings page can change
  (`inboxDir`, `model`, `ollamaBaseUrl`, `ocrModel`) to `<dataDir>/settings.json` as one
  merged JSON object. Precedence in `config.ts` for each: env var > persisted file > default —
  the env var always wins so an operator's explicit override can't be shadowed by something
  saved from the UI earlier, and when an env var is set that field is `envLocked` (UI shows it
  read-only, `PUT /settings` refuses to change it). Changing `model`/`ollamaBaseUrl` at runtime
  rebuilds the agent + extraction model clients in `server.ts` and, via the `onModelChange`
  callback, restarts the inbox watcher with a fresh client — a langchain `ChatOllama` binds its
  URL and model at construction, so hot-patching isn't possible.
- `agents/index.ts` — the deepagents planner (`buildFamilyAgent`) plus its two subagents,
  `task-agent` and `document-agent`. Notable non-obvious things in this file:
  - deepagents bakes in generic `ls`/`read_file`/`write_file` tools for its own scratch
    filesystem; these are explicitly permission-denied and stripped down to just `read_file` via
    `createFilesystemMiddleware`, because small local models reliably confuse "documents" (this
    app's domain concept) with "files" (deepagents' concept) otherwise.
  - `askFamilyAgent()` retries once on an empty reply *or* a reply containing raw tool-call
    syntax (`LOOKS_MALFORMED` regex) — both are real small-model failure modes, not
    hypothetical. It also takes an optional `images: string[]` (data URIs) — the chat UI in
    both apps can attach photos/screenshots, and it builds a multimodal `HumanMessage`
    content array for the (multimodal) planner model. Subagents only ever get a text
    `description`, so an image never propagates past the planner turn.
  - System prompts contain worked examples, not just abstract instructions — abstract phrasing
    alone was proven insufficient to get reliable tool delegation out of small models.
- `agents/extraction.ts` — document field extraction **deliberately bypasses the planner**. It
  binds a single-purpose tool directly to the model with the document id captured in a closure,
  rather than routing through planner → `task` tool → `document-agent` (which requires the model
  to transcribe an id from a prompt — a small model garbled one mid-string during testing). Use
  this pattern (direct tool binding, no delegation) for any other system-triggered, no-user-in-
  the-loop pipeline step; keep the full planner path for anything conversational.
- `db.ts` — `node:sqlite` (`DatabaseSync`, built into Node ≥22.5, no native compile step). Tasks
  and documents get short 8-char Crockford-base32 ids (`shortId()`), not UUIDs — small models
  transcribe short ids reliably and 36-char UUIDs unreliably. Every mutating method logs to the
  `activity` table itself, so the activity log can't drift out of sync with what actually happened.
- `inboxWatcher.ts` — chokidar watch on `config.inboxDir`. Delegates to `fileExtract.ts` for
  whatever's supported there (text, PDF, images); anything else is logged as skipped, not
  silently ignored. Dedupes on `source_path` so restarts don't reprocess files.
- Document ingestion has three entry points into the same pipeline: `POST /documents/ingest`
  (paste text, JSON body), `POST /documents/upload` (multipart file — PDF/photo/scan, the
  `@fastify/multipart`-backed route), and the inbox watcher above. All three end up at
  `store.createDocument()` + `extractDocument()`.
- `config.ts` — every config value has an env var override; nothing else in the codebase should
  read `process.env` directly.

**desktop** (`desktop/`): `src/` is plain TS/HTML/CSS (no framework) built with Vite;
`src-tauri/` is the Rust shell. `main.rs` spawns `agent-core`'s built `dist/server.js` as a child
process via `node`, with `PR_SET_PDEATHSIG` set on the child (Linux, via `libc::prctl` in a
`pre_exec` hook) so a hard-killed parent can't orphan it — this was a real bug, found by testing
`kill -9` against the running app, not defensive-by-default.

**android** (`android/app/src/main/kotlin/app/familyagent/android/`): single-Activity Compose
app, `AppViewModel` holds all state as one `StateFlow<AppUiState>`, `FamilyAgentApi` is a thin
OkHttp + kotlinx.serialization client. Server URL is entered by hand in Settings and persisted via
DataStore (`SettingsStore`) — there's no service discovery. From an emulator, `10.0.2.2` is the
alias for the host machine running agent-core. `DocumentsScreen` uploads files via a system
picker (`GetContent`) or camera capture (`TakePicture` + a `FileProvider` — see
`res/xml/file_paths.xml` and the `<provider>` entry in `AndroidManifest.xml`); both paths funnel
into `FamilyAgentApi.uploadDocument()`, an OkHttp `MultipartBody` POST to the same
`/documents/upload` route the desktop upload UI uses.

## Scope notes

Three subagents ship: `task-agent`, `document-agent`, and `builder-agent`. The last one
generates small self-contained web tools (`agent-core/src/tools/*`, and a "Tools" screen in
both apps) — see `docs/STATUS.md` for the architecture. Static tools are plain inline HTML
served with a strict CSP from a dedicated port (default 4174); a tool that needs shared state
gets a Deno backend in a deny-by-default sandbox (`ToolSupervisor`), with the model only ever
writing `handler.ts`. `FAMILY_AGENT_TOOLS=0` disables the whole feature.

Still not implemented from the brainstormed architecture: the compute mesh, Tailscale
transport, and the bundled managed-model runtime. Full reasoning for every scope cut is in
`docs/DECISIONS.md`.
