# Family Agent

A local-first agentic app for organizing a family's documents, schedules, and
misc to-dos. Everything — the model, the storage, the document processing —
runs on hardware you own. Nothing is sent to a cloud API.

Three apps share one backend:

- **agent-core** — a Node/TypeScript service that runs a local LLM-backed
  planner (via [deepagents](https://github.com/langchain-ai/deepagentsjs))
  behind a small HTTP API, backed by SQLite and a local Ollama instance.
- **desktop** — a [Tauri](https://tauri.app) app that spawns agent-core as a
  sidecar process and gives it a UI.
- **android** — a native Kotlin/Compose companion app that talks to
  agent-core over the LAN.

This is a working prototype, not a finished product — see
[**docs/STATUS.md**](docs/STATUS.md) for exactly what's verified vs. not, and
[**docs/DECISIONS.md**](docs/DECISIONS.md) for the reasoning (including
mistakes and fixes) behind every non-obvious choice below.

## How it's put together

```
┌─────────────┐        ┌───────────────────────────┐        ┌────────────┐
│   desktop    │──HTTP──▶│    agent-core (:4173)     │──HTTP──▶│   Ollama   │
│  (Tauri)     │  spawns │  Fastify · SQLite · watch │        │  (:11434)  │
└─────────────┘        └──────────────┬────────────┘        └────────────┘
                                        ▲
                                        │ HTTP (LAN)
                                 ┌──────┴──────┐
                                 │   android    │
                                 │  (Compose)   │
                                 └─────────────┘
```

**agent-core** is the only thing that talks to Ollama or touches the
filesystem. It owns:

- **A planner + two subagents** (`agents/index.ts`) — `task-agent` for
  to-dos, `document-agent` for reading/classifying documents. The planner
  reaches for a `task` delegation tool rather than acting on domain requests
  itself; conversational requests go through this path, and it's been tuned
  (with worked examples, not just instructions — abstract prompting alone
  wasn't reliable) against real small-model failure modes like confusing
  "documents" with its own scratch filesystem.
- **A local-by-default model policy** — every agent runs against Ollama
  locally (`gemma4:e2b` by default); there's no cloud fallback wired up at
  all. `FAMILY_AGENT_MODEL` picks a different model if you've pulled one.
- **File ingestion** three ways: paste text (`POST /documents/ingest`),
  upload a PDF/photo/scan (`POST /documents/upload` — PDF text-layer
  extraction via `pdf-parse`, image OCR via `tesseract.js`), or drop a file
  into a watched folder (`inboxWatcher.ts`, chokidar). Document field
  extraction (category/summary/dates) is done via a single tool bound
  directly to the model rather than routed through the planner — a
  deliberate choice after a small model garbled a document id mid-transcription
  when that path went through subagent delegation instead.
- **A live-editable setting**: the watched folder's location
  (`GET`/`PUT /settings`), changeable from the desktop Settings page without
  restarting the app. Model and Ollama URL are env-var-only — swapping a
  running model client mid-request isn't something to do casually.
- **An activity log** that every mutating action writes to itself, so it
  can't drift out of sync with what actually happened.

**desktop** and **android** are both thin HTTP clients over the same API —
Chat, Tasks, Documents, Activity, and Settings (desktop only; the Android
equivalent is pointing the app at a server address, since it's the one
without a local agent-core of its own to configure).

## Prerequisites

- **Node.js 22.5+** (uses `node:sqlite`, no native module build) and **Rust
  + Cargo** for the Tauri desktop app.
- **[Ollama](https://ollama.com)**, running locally, with the model pulled:
  ```bash
  ollama serve &
  ollama pull gemma4:e2b
  ```
  The model has to support tool-calling in Ollama's serving layer — that's a
  property of the specific model, not something this app can route around.
  See `docs/DECISIONS.md` for what happens if it doesn't.
- **Android toolchain**, only if you're building the Android app: JDK 17 +
  Android SDK. `.toolchains/` at the repo root holds a machine-local copy
  (gitignored) if you've already set one up; see `docs/BUILD_LOG.md`'s
  "android" section for how to install one from scratch without root access.

## Running it

**Easiest path** — two scripts from the repo root, each does its own
readiness checks:

```bash
./scripts/start-desktop.sh   # checks Ollama/model, then launches the Tauri app
./scripts/start-android.sh   # detects a running emulator or boots one, then
                              # builds, installs, and launches the app on it
                              #   --memory MB   RAM for a newly-booted emulator (default 2048)
```

`start-android.sh` is safe to re-run — it reuses whatever emulator is
already up rather than starting a second one. Set
`FAMILY_AGENT_EMULATOR_HEADLESS=1` to boot headless instead of with a
visible window (useful for CI or a machine with no display).

**Manual path**, piece by piece:

```bash
# agent-core (build once, or `npm run dev` for live reload)
cd agent-core && npm install && npm run build && npm start

# Desktop app (spawns agent-core itself — no need to start it separately)
cd desktop && npm install && npm run tauri:dev
# or: npm run tauri:build   → .deb/.AppImage in src-tauri/target/release/bundle

# Android
cd android
export JAVA_HOME=$(pwd)/../.toolchains/jdk17
export ANDROID_HOME=$(pwd)/../.toolchains/android-sdk
./gradlew installDebug   # needs a device/emulator already connected (adb devices)
```

Once the Android app is running, open **Settings** and point it at
agent-core's address — `http://10.0.2.2:4173` from an emulator (the
emulator's alias for the host machine), or `http://<lan-ip>:4173` from a
real phone on the same network.

## Testing

```bash
npm test                                    # from repo root: agent-core, then desktop
cd android && ./gradlew testDebugUnitTest   # Android unit tests, no device needed
```

`agent-core`'s suite has two tiers: fast unit tests (SQLite storage, HTTP
routes, file extraction, CORS, the model-reply retry logic) and slower
live-model integration tests that make real calls to Ollama — those
**skip themselves automatically** if the configured model isn't reachable,
so `npm test` still passes green without Ollama running, just with fewer
tests executed. A full run against a live model takes a few minutes; small
local models are genuinely slow, and several real bugs in this codebase
were only ever caught by these tests, not the fast ones — see
`docs/DECISIONS.md` for two concrete examples.

## What's deliberately not here

The original brainstorm for this app (worth a read if you want the fuller
vision) describes more than what's built: a compute mesh across family
devices, Tailscale/relay transport for the phone app, a bundled/managed
local-model runtime, and a sandboxed agent that builds one-off interactive
tools on request. None of that exists yet. The sandboxed builder agent in
particular is deferred on purpose — it implies arbitrary local code
execution, and that's not something to stand up without a human reviewing
the sandbox boundary first. Full reasoning for every scope cut is in
`docs/DECISIONS.md`.

PDF support is text-layer extraction only (no OCR fallback for a scanned
PDF with no embedded text). Photos and camera scans go through OCR
instead — that's the actual "scan a document" path. The first OCR call
downloads an ~4MB English language model from a CDN and caches it locally
under `agent-core/data/tessdata/`; every call after that is fully offline.
It's the one deliberate exception to "nothing leaves the machine" in this
codebase, and it's flagged here on purpose, not hidden.
