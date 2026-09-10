<p align="center">
  <img src="assets/header.svg" alt="Family Agent — local-first family organizer" width="760">
</p>

A local-first agentic app for organizing a family's documents, schedules, and
misc to-dos. Everything — the model, the storage, the document processing —
runs on hardware you own. Nothing is sent to a cloud API.

<p align="center">
  <img src="assets/promo.svg" alt="Family Agent on macOS and iPhone — the same conversation, answered by a model running on your own laptop" width="960">
</p>

It's **multi-user**: the home laptop runs the master node, an admin does a
one-time setup, and each family member gets a local account with their own
isolated tasks, documents, history, and tools. Clients sign in with a
username + password; the Android app finds the master node on the LAN
automatically (mDNS). Sharing things *between* accounts is the next step, not
built yet.

Four apps share one backend:

- **agent-core** — a Node/TypeScript service that runs a local LLM-backed
  planner (via [deepagents](https://github.com/langchain-ai/deepagentsjs))
  behind a small HTTP API, backed by SQLite and a local Ollama instance.
- **desktop** — a [Tauri](https://tauri.app) app that spawns agent-core as a
  sidecar process and gives it a UI. Builds on Linux (`.deb`/`.appimage`) and
  macOS (`.app`/`.dmg`, with agent-core + a Node runtime bundled in).
- **android** — a native Kotlin/Compose companion app that talks to
  agent-core over the LAN.
- **ios** — a native SwiftUI companion app, full feature parity with Android,
  using Apple Liquid Glass on iOS 26 (with an iOS 18 fallback). See
  [`ios/README.md`](ios/README.md).

This is a working prototype, not a finished product — see
[**docs/STATUS.md**](docs/STATUS.md) for exactly what's verified vs. not, and
[**docs/DECISIONS.md**](docs/DECISIONS.md) for the reasoning (including
mistakes and fixes) behind every non-obvious choice below.

## How it's put together

<p align="center">
  <img src="assets/architecture.svg" alt="desktop, android and ios talk over HTTP to agent-core (:4173); agent-core talks to a local Ollama (:11434)" width="820">
</p>

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
- **Local accounts + sessions** (`auth.ts`, `users`/`sessions` tables) —
  scrypt-hashed passwords, opaque bearer tokens (only the sha256 is stored).
  A `preHandler` hook attaches the caller's `ScopedStore`; every
  task/document/activity/tool query is scoped by `user_id`. One deepagents
  planner and one watched folder per account. Machine settings (model, Ollama
  URL, OCR, home name) are admin-only; the watched folder is per-user and
  live-editable. `GET`/`PUT /settings` and `GET /health` still work the same
  otherwise.
- **LAN discovery** — the node advertises itself over mDNS
  (`_familyagent._tcp`, via `bonjour-service`); binds `0.0.0.0` so phones can
  reach it. `FAMILY_AGENT_MDNS=0` turns advertising off.
- **An activity log** that every mutating action writes to itself, so it
  can't drift out of sync with what actually happened.

**desktop** and **android** are both thin HTTP clients over the same API —
Chat, Tasks, Documents, Activity, Settings, and (desktop, admin only) a
Family screen for managing accounts. First launch shows setup (desktop) or
server-discovery + login (Android).

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

**First launch:**

- **desktop** shows a setup screen (create the owner/admin account, name the
  home), then the app. Add family members from the **Family** screen.
- **android** scans the LAN for the master node and lists it; tap it and sign
  in. If discovery doesn't find it (some networks block mDNS), use "Enter an
  address manually" — `http://10.0.2.2:4173` from an emulator, or
  `http://<lan-ip>:4173` from a real phone.
- A dev/test server can be bootstrapped directly:
  `curl -XPOST localhost:4173/auth/bootstrap -H 'content-type: application/json' -d '{"username":"me","displayName":"Me","password":"secret123"}'`.

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
