# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A local-first agentic app for family document, schedule, and task organization: a Node/TS
backend (`agent-core`) running a deepagents-based planner behind a local HTTP API, a Tauri
desktop app, and a native Android companion app. Everything runs on the user's own machine —
inference goes through a local Ollama instance, nothing is sent to a cloud API. The two
opt-in capabilities that *can* reach off-box (web search/fetch, and CLI-tool file processing)
are off by default and covered under "Web + shell capabilities" below. Read
`docs/STATUS.md` first if you haven't touched this repo before; `docs/DECISIONS.md` explains
every non-obvious choice below (and *why*), `docs/BUILD_LOG.md` has the chronological blow-by-blow
of what broke and how it was fixed.

It is **multi-user**. `agent-core` on the home laptop is the master node: an admin does a
one-time setup, then creates a local account per family member. Every account has its own
isolated tasks, documents, activity, chat, tools, and watched folder. Clients authenticate
with username + password and carry a bearer token on every request; `agent-core` binds
`0.0.0.0` and advertises itself on the LAN over mDNS (`_familyagent._tcp`) so the Android app
can discover it. Cross-account features (added later): **family chat** — 1:1 DMs
and Slack-style group channels, with `@agent` pulling the planner into a
conversation — and a **shared sticky-note board** alongside each person's private
board. Everything else (tasks/"Events", documents, tools, activity) stays
per-account. See `docs/STATUS.md` and `docs/DECISIONS.md` → "Cross-account chat".

The **desktop** app follows `DESIGN.md` at the repo root (the "Notion — warm paper notebook"
palette: `#f6f5f4` canvas, single `#0075de` blue accent, Inter + Source Serif 4, **light theme
only**) with a Gemini-inspired **atmosphere layer** on top: an animated gradient canvas
(`body::before/::after` bloom layers), translucent-glass chrome, soft floating card shadows
(`--shadow-sm` is no longer `none`), rounder corners (`--r-lg` 16, `--r-xl` 22), and springy
view/bubble transitions — all frozen under `prefers-reduced-motion`. It's one appended block at
the end of `desktop/src/style.css` plus the `:root` token edits. Tokens live in
`desktop/src/style.css` `:root`. See `DESIGN.md` → "Desktop atmosphere layer" and
`docs/DECISIONS.md`.

The **Android** app **converged onto the same look** (as of 2026-09-07 — it previously had a
standalone "Playful Color" indigo/pink/cyan system, now retired). Same warm `#f6f5f4` canvas,
single `#0075de` blue accent, Inter (+ Source Serif for subtitles), floating cards, an animated
gradient canvas (`ui/Atmosphere.kt` — the counterpart of `body::before`), springy `NavHost`
transitions. **No app bar** — a floating white menu button opens the `ModalNavigationDrawer`.
Surfaces are opaque (Android has no cheap backdrop blur, so no glass — cards float over the
gradient via shadows). **Light only now** — no dark mode, no `values-night/`.
Tokens live in `android/.../ui/theme/Theme.kt` (`LightColors`, `AppAccents`, `AppTypography`,
`AppShapes`) and `android/app/src/main/res/values/colors.xml`. It's still a hand-maintained
mirror — a token change on one platform is a deliberate, separate change on the other, not
automatic. See `android/DESIGN.md` and `docs/DECISIONS.md` → "Converging Android onto the
desktop style".

## Prerequisites

- Ollama running locally with the model pulled: `ollama serve &` then `ollama pull gemma4:e2b`
  (default model; override with `FAMILY_AGENT_MODEL`). The model **must** support tool-calling in
  Ollama's serving layer — that's a property of the specific model, not something deepagents
  provides. Not every model does; confirmed failures and the reasoning are in `docs/DECISIONS.md`.
  - *Optional:* `ollama pull nomic-embed-text` enables semantic document search (`config.embedModel`,
    `FAMILY_AGENT_EMBED=0` to turn off). Without it, document search is keyword + trigram-fuzzy only —
    no error, it just falls back. See `docs/DECISIONS.md` → "Follow-up: semantic + fuzzy document search".
- *Optional, for the shell/file-processing capability* (`FAMILY_AGENT_SHELL=1`): `bubblewrap` (the
  sandbox — `apt install bubblewrap`, needs unprivileged user namespaces) plus whichever CLI tools you
  want the agent to use (`ffmpeg`, `qpdf`, `imagemagick`, `poppler-utils`, `jq`, `csvkit`, `pandoc`, …).
  Only installed tools are advertised; missing bwrap = the capability stays off. See
  `docs/DECISIONS.md` → "Web access and shell/file-processing".
- *Optional, for the web capability*: an admin can turn it on in the app
  (Settings → Internet access — pick DuckDuckGo for a keyless setup), or pin it with
  `FAMILY_AGENT_WEB_SEARCH_PROVIDER` = `searxng` (+ `_URL`), `tavily`/`brave` (+ `_API_KEY`),
  or `ddg`. An env var makes the in-app control read-only.
- *Optional, for the password vault*: no extra deps — the crypto is Node's built-in
  `node:crypto`. Off by default; an admin flips it on from Settings, or pin it with
  `FAMILY_AGENT_VAULT=1`/`0`. `FAMILY_AGENT_VAULT_AI=0` keeps the vault but denies the
  assistant. See "Password vault" below.
- Android toolchain (JDK 17, Android SDK) lives in `.toolchains/` at the repo root, gitignored and
  machine-local — see `docs/BUILD_LOG.md`'s "android" section if it's missing and needs
  reinstalling.
- **First run of the app** (any client): `agent-core` starts with zero accounts. The desktop
  shows a setup screen (create the owner/admin account + name the home); the Android app
  discovers the server on the LAN then shows a login screen. A test/dev server can be
  bootstrapped with `curl -XPOST .../auth/bootstrap -d '{"username":...,"password":...}'`.
  `FAMILY_AGENT_SERVER_NAME` pins the home name; `FAMILY_AGENT_MDNS=0` disables LAN advertising.

## Commands

Easiest path — launcher scripts that do their own readiness checks:
```bash
./scripts/start-desktop.sh   # rebuilds agent-core, launches the Tauri app (Linux or macOS)
./scripts/start-android.sh   # detects/boots an emulator, builds, installs, launches the app
./scripts/start-ios.sh       # boots an iOS simulator, builds, installs, launches the app
                              #   --login user:pass  --start <screen>   (DEBUG auto sign-in)
./scripts/show-accounts.sh   # prints local accounts (username/role) from the SQLite store —
                              # for a forgotten admin username
./scripts/reset-password.sh <username> [password]   # resets an account's password (locked-out admin).
                                                     # See docs/STATUS.md "Recovering a locked-out admin".
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

**Never test against the installed production desktop app or its data.** It
holds the user's real accounts, documents, and vault, and shares the default
data dir (`$XDG_DATA_HOME/family-agent`, i.e. `~/.local/share/family-agent`,
on every platform) and port `4173`. For any manual/smoke testing, start a
throwaway dev instance instead: a fresh
`FAMILY_AGENT_DATA_DIR=$(mktemp -d)` (a new temp dir under `/tmp` per run — it
bootstraps with zero accounts, so `POST /auth/bootstrap` a test admin) **and**
a non-default `PORT` (e.g. `PORT=4273`, with the tools server following via
`FAMILY_AGENT_TOOLS_PORT`). Point the client you're testing at that port. Throw
the temp dir away when done; don't reuse it across unrelated test runs.

**android** (`cd android`, needs `JAVA_HOME`/`ANDROID_HOME` pointed at `../.toolchains/`):
```bash
export JAVA_HOME=$(pwd)/../.toolchains/jdk17
export ANDROID_HOME=$(pwd)/../.toolchains/android-sdk
./gradlew testDebugUnitTest             # unit tests (FamilyAgentApi against MockWebServer)
./gradlew testDebugUnitTest --tests "*.FamilyAgentApiTest.health parses model and status"
./gradlew assembleDebug                 # -> app/build/outputs/apk/debug/app-debug.apk
./gradlew installDebug                  # build + install on a connected device/emulator
```

**ios** (`cd ios`, needs Xcode 16+ / an iOS 18+ simulator):
```bash
xcodebuild -resolvePackageDependencies -project FamilyAgent.xcodeproj -scheme FamilyAgent
xcodebuild -project FamilyAgent.xcodeproj -scheme FamilyAgent -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build build
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/FamilyAgent.app  # or: ./scripts/start-ios.sh
xcrun simctl launch booted app.familyagent.ios
```
The simulator shares the Mac's network — point discovery / manual entry at
`http://localhost:4173`. DEBUG-only launch env for smoke tests:
`SIMCTL_CHILD_FA_SERVER_URL` + `SIMCTL_CHILD_FA_AUTOLOGIN=user:pass` +
`SIMCTL_CHILD_FA_START=<destination>` (+ `_FA_CHAT_PROMPT` to auto-send a chat).

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

Four independent apps sharing one HTTP contract, no shared code between them (types are
duplicated by hand in each client — `desktop/src/api.ts`, `android/.../data/ApiModels.kt`,
and `ios/FamilyAgent/Networking/DTOs.swift` — rather than via a shared package).

```
agent-core (Node/TS, 0.0.0.0:4173)  <--HTTP+bearer-->  desktop (Tauri, spawns agent-core as a sidecar)
        ^                                                android (Kotlin/Compose, mDNS discovery + login)
        |
     Ollama (local, port 11434)
```

**Auth / multi-user.** `agent-core/src/auth.ts` (scrypt password hashing, opaque bearer
tokens — only their sha256 is stored, in the `sessions` table). `agent-core/src/db.ts` owns
`users`/`sessions` plus a `user_id` column on every owned table; **`ScopedStore`** (from
`store.scoped(userId)`) is the isolation boundary — it exposes the same task/document/activity/
tool methods the single-user `Store` used to, each scoped with `WHERE user_id = ?`, so
`makeTaskTools` / `makeDocumentTools` / `extraction.ts` / `inboxWatcher.ts` were barely
touched. `server.ts` has a `preHandler` auth hook (public routes: `/health`, `/auth/status`,
`/auth/login`, `/auth/bootstrap`); it builds one deepagents planner **per user**, bound to
that user's `ScopedStore`, and `main()` runs one inbox watcher per user
(`<inboxBase>/<userId>` by default, or `users.inbox_dir`). First run: `GET /auth/status`
returns `needsSetup: true` → `POST /auth/bootstrap` creates the first admin and reassigns any
data from a migrated single-user DB (owned by the `_legacy_` sentinel). Machine settings
(`model`, `ollamaBaseUrl`, `ocrModel`, `serverName`) are admin-only; `inboxDir` is per-user.
An upgraded single-user DB is migrated in `Store.migrate()` (adds `user_id` with a DEFAULT).
iOS and Android's login screens have a **"Remember me"** toggle (on by default) that saves the
typed username/password locally, keyed per server address, and pre-fills the form next time —
purely a client-side convenience for re-typing credentials, unrelated to the session bearer
token (which is what actually keeps a device signed in). iOS: `RememberedLogin` in
`Networking/Keychain.swift` (real Keychain entry). Android: `SettingsStore.rememberedLogin`/
`saveRememberedLogin` (plain DataStore, same trust boundary as the token already stored there —
not field-level encrypted). Unchecking it on a sign-in clears anything saved for that server.

**QR phone pairing.** The desktop "Pair a phone" panel has a toggle (device-local
`localStorage` `familyAgent.pairAutoLogin`, **default on**): on, the QR carries a
`{url,name,t}` JSON envelope where `t` is a single-use pairing token
(`pairing_tokens` table, sha256-stored, 5-min TTL, `PAIRING_TOKEN_TTL_MS`) minted by
`POST /auth/pair/start` (authed — bound to the signed-in desktop account, one live at
a time); the phone reads it via `PairingPayload` and `POST /auth/pair/redeem` (public)
trades it for a real session — no password, no vault auto-unlock. Toggle off = the QR
is the bare `http://host:port` string and the phone still shows the login screen.
Only iOS has a scanner (`QRScanSheet` → `AppModel.handleScannedPairing`); the desktop
re-mints the token when Settings opens and every ~3.5 min it stays open. Tests:
`agent-core/test/pairing.test.ts`.

**agent-core** (`agent-core/src/`):
- `server.ts` — Fastify app. `buildServer(store, hooks?, supervisor?)` is the testable factory
  (used directly by tests via `app.inject` — tests seed a user + token with
  `test/helpers.ts`'s `seedUser` / `authInject`); `main()` wires it to a real port, runs one
  inbox watcher per account, publishes the mDNS record, and supplies the `hooks`
  (`onUserInboxChange` / `onModelChange` / `onUserCreated` / `onUserDeleted` /
  `onServerNameChange`). The `preHandler` auth hook attaches `req.authUser` + `req.userStore`
  (a `ScopedStore`) to every non-public route; `requireAdmin` gates `/users` and machine
  settings. CORS is fully open (`origin: true`) deliberately — the bearer token is the access
  control, not the origin (see `docs/DECISIONS.md`). **`methods` must be listed explicitly**
  (`["GET", "POST", "PATCH", "PUT", "DELETE"]`) — `@fastify/cors` defaults to `GET,HEAD,POST`
  only, which silently broke `PATCH`/`PUT` from the real desktop webview for a while (curl and
  `app.inject()` both bypass real CORS preflight). If you add a route using a new HTTP method,
  add it here too.
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
- `transcribe.ts` — speech-to-text for the mic button in both chat composers (`POST
  /transcribe`, multipart WAV in, `{ text }` out). Whisper via transformers.js
  (`@huggingface/transformers` + `onnxruntime-node`), run **in-process** — Ollama can't
  serve ASR, so this is a separate inference path with the same shape as OCR: heavy import
  lazy-loaded on first call, model (`config.asrModel`, default `Xenova/whisper-base`) pulled
  from the HF CDN once and cached under `<dataDir>/asr-models/`. Like `agents/extraction.ts`
  it never touches the planner — a transcript is a mechanical step; the endpoint just returns
  text for the user to review. Clients send a 16 kHz mono WAV so the module is a
  dependency-free header parse (`decodeWav`), not an audio-codec problem. `FAMILY_AGENT_ASR=0`
  disables it (route 403s, `/health.asrEnabled` false, both clients hide the mic button).
  The mic button has **two gestures**: a quick **tap** dictates into the composer for review
  (never auto-sent — the original behaviour); a **press-and-hold** is push-to-talk — a
  full-screen "listening" overlay with a live waveform, and on release the clip is
  transcribed **and sent immediately**, with the reply **spoken back** (voice in → voice out,
  regardless of the auto-read setting). Sliding the pointer/finger off the button before
  releasing cancels it (Esc also cancels on desktop). Desktop: `wireMic` in `main.ts` (pointer
  events, `#voice-overlay` in `index.html`, `startRecording(onLevel)` in `audio.ts` feeds the
  bars); a channel reply is spoken via the poll loop (`maybeSpeakAgentReply`, 240s window).
  Android: `HoldToTalkMic` + `VoiceOverlay` in `ui/VoiceOverlay.kt` (Compose `awaitEachGesture`,
  `VoiceRecorder.amplitude` StateFlow), `AppViewModel.sendChatVoice` / `sendChannelVoice`
  (`speakReply`), `maybeSpeakChannelReply` on the channel poll.
- `tts.ts` — text-to-speech for the "Read aloud" button on every assistant/agent reply (`POST
  /speak`, JSON `{ text, voice? }` in, `audio/wav` out; `GET /tts/voices` lists the 28 voices).
  **Kokoro-82M** (`config.ttsModel`, default `onnx-community/Kokoro-82M-v1.0-ONNX`, `q8` ~86MB)
  via `kokoro-js` (deps `@huggingface/transformers` + a **WASM espeak-ng** phonemizer, no native
  binary), run **in-process** — Ollama can't serve TTS, same third-inference-path shape as
  `transcribe.ts`/OCR: heavy import lazy-loaded on first call (~15-20s cold, ~2-5s/reply after),
  model cached under `<dataDir>/tts-models/`. Off the planner (a mechanical step): `plainText()`
  strips markdown, text clamped to 2000 chars, `tts.generate()` → `encodeWav16()` re-encodes
  Kokoro's 32-bit-float WAV to **16-bit PCM** (Android `MediaPlayer` won't play float WAV).
  Default voice `af_heart` (`config.ttsVoice` / `FAMILY_AGENT_TTS_VOICE` / `settings.json`,
  admin-settable, applied per-call — no agent rebuild). Auto-read ("read replies aloud
  automatically") is **client-local** (desktop `localStorage` `familyAgent.autoRead`, Android
  DataStore `auto_read_replies`), off by default, private 1:1 Chat only (never family channels,
  never an error reply). `FAMILY_AGENT_TTS=0` disables it (routes 403, `/health.ttsEnabled`
  false, both clients hide the button + Settings toggle).
- `embeddings.ts` — semantic document search. A local Ollama embedding model (`config.embedModel`,
  default `nomic-embed-text`; `FAMILY_AGENT_EMBED=0` disables) turns each document's chunks into
  vectors stored by `db.ts` (`document_embeddings`); a query is embedded and matched by
  brute-force cosine. Same off-planner shape as `extraction.ts` / `transcribe.ts` — kicked off
  the ingest path, degrades to keyword+fuzzy when the model's unreachable (an `/api/tags` probe,
  same guard the integration tests use). `searchDocumentsSmart()` is the one orchestrator the
  `GET /documents/search` route and `search_documents` tool call: dispatches on `mode`
  (`keyword|fuzzy|semantic|hybrid`, default hybrid) and merges the legs with reciprocal-rank
  fusion (`rrfMerge`). `chunkDocumentText()` is paragraph-aware. `backfillEmbeddings()` runs at
  startup and after a `PUT /settings` model change.
- `settingsFile.ts` — persists the settings the desktop Settings page can change
  (`inboxDir`, `model`, `ollamaBaseUrl`, `ocrModel`, `asrModel`, `ttsVoice`, `embedModel`) to `<dataDir>/settings.json` as one
  merged JSON object. Precedence in `config.ts` for each: env var > persisted file > default —
  the env var always wins so an operator's explicit override can't be shadowed by something
  saved from the UI earlier, and when an env var is set that field is `envLocked` (UI shows it
  read-only, `PUT /settings` refuses to change it). Changing `model`/`ollamaBaseUrl` at runtime
  rebuilds the agent + extraction model clients in `server.ts` and, via the `onModelChange`
  callback, restarts the inbox watcher with a fresh client — a langchain `ChatOllama` binds its
  URL and model at construction, so hot-patching isn't possible.
- `agents/index.ts` — the deepagents planner (`buildFamilyAgent`) plus its subagents
  `task-agent`, `document-agent`, `builder-agent`, `notes-agent`, `tools-agent`, `routine-agent`,
  and the `askFamilyAgent` / `askFamilyAgentInChannel` / `mentionsAgent` helpers. Notable
  non-obvious things in this file:
  - `tools-agent` (`agents/toolTools.ts`) is dynamic: `builder-agent` *makes* a tool,
    `tools-agent` *uses* one the family already built. Three generic tools —
    `list_family_tools` (compact catalog) → `describe_family_tool` (one operation's
    full nested schema) → `call_family_tool` — resolving the catalog live each turn
    from `<toolDir>/mcp.json` caches (a `familyTools.getCatalog` dep), so a new/rebuilt/
    deleted tool needs no graph rebuild. Only wired when `config.toolsEnabled`.
    `connections-agent` (MCP) has the same `list_ → describe_ → call_` trio; schema
    rendering is shared in `agents/schemaText.ts`. See `docs/DECISIONS.md` → "Tools
    as an agent API (MCP)" and "Skills and MCP" → "a `describe_*` rung".
  - deepagents bakes in generic `ls`/`read_file`/`write_file` tools for its own scratch
    filesystem; these are explicitly permission-denied and stripped down to just `read_file` via
    `createFilesystemMiddleware`, because small local models reliably confuse "documents" (this
    app's domain concept) with "files" (deepagents' concept) otherwise.
  - subagents get `search_documents` / `search_tasks` (keyword search, `db.ts`) alongside the
    `list_*` tools; the prompts push both subagents to search for a specific thing and reserve
    `list_*` for "show me everything". Historically they only had `list_*` — see `docs/DECISIONS.md`.
  - `askFamilyAgent()` retries once on an empty reply *or* a reply containing raw tool-call
    syntax (`LOOKS_MALFORMED` regex) — both are real small-model failure modes, not
    hypothetical. It also takes an optional `images: string[]` (data URIs) — the chat UI in
    both apps can attach photos/screenshots, and it builds a multimodal `HumanMessage`
    content array for the (multimodal) planner model. Subagents only ever get a text
    `description`, so an image never propagates past the planner turn. **A non-image
    file** (PDF, scan, `.txt`/`.md`) attached in the desktop chat composer is uploaded via
    `POST /documents/upload` first; its id rides along in `POST /chat`'s `documentIds`, and
    the route **prepends that document's extracted `rawText`** (per-doc 8 KB cap) to the
    model's copy of the message — the stored transcript keeps the user's own words, and each
    attached doc is pushed as a `document` `ChatReference` so a chip renders under the reply.
    Family channels stay image-only (`{ allowDocs: false }` on their tray); iOS/Android
    composers pick images only, so this is desktop-only for now. It also takes an
    optional `history: {role, content}[]` — prior turns of the same persisted chat session,
    prepended ahead of the current message in the `messages` array passed to `agent.invoke`
    (text only; images aren't replayed, to avoid multiplying an already-slow CPU turn). See
    "chat history sessions" below.
  - System prompts contain worked examples, not just abstract instructions — abstract phrasing
    alone was proven insufficient to get reliable tool delegation out of small models.
  - **The planner prompt only advertises subagents that are actually wired.** `PLANNER_PROMPT`
    is the always-true base (the 5 core subagents); `buildPlannerPrompt({ tools, web, shell })`
    appends `PLANNER_{TOOLS,RESEARCH,WORKSHOP}_SECTION` per enabled capability. Telling the
    model about a subagent that isn't in the `subagents` array makes it delegate there, and
    deepagents' `task` tool *throws* on an unknown `subagent_type` — which used to abort the
    turn and surface as "the local model could not be reached". `askFamilyAgent` also catches
    that specific throw defensively (returns "the X helper isn't turned on" instead of 502),
    and `/chat`'s catch-all only blames Ollama when the error text looks like a connection
    failure. See `docs/DECISIONS.md` → "Planner delegated to a disabled subagent".
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
  **Search** is FTS5 (`documents_fts` / `tasks_fts`), kept in sync by triggers on the base tables
  (same "can't drift" principle, pushed into the DB) with a startup row-count reconcile that
  backfills a legacy DB. `ScopedStore.searchDocuments()` / `searchTasks()` do `bm25()` ranking +
  `snippet()` + structured filters (category / important-date range read straight out of the
  extracted-fields JSON); `toFtsMatchQuery()` turns free text into a safe `MATCH` expression (a
  raw NL string is an FTS syntax error, not a no-op). Empty query = filtered recency list.
  **Documents also get fuzzy + semantic search** (`docs/DECISIONS.md` → "Follow-up: semantic +
  fuzzy document search"): a third mirror `documents_trigram` (FTS5 `trigram` tokenizer, same
  triggers) for typo/substring tolerance, re-ranked by `trigramSimilarity()` (Dice on trigram
  sets); and `document_embeddings` (Float32 BLOB vectors from a local Ollama embedding model,
  `config.embedModel`, `FAMILY_AGENT_EMBED=0` to disable) with a brute-force cosine scan.
  `agent-core/src/embeddings.ts` owns the embedding path (same off-planner shape as
  `extraction.ts`) and `searchDocumentsSmart()` — the single orchestrator that `GET
  /documents/search` (`?mode=keyword|fuzzy|semantic|hybrid`, default hybrid) and the
  `search_documents` tool call; it merges the legs with reciprocal-rank fusion and falls back to
  keyword+fuzzy whenever the embedding model is off/unreachable. Vectors are (re)built off every
  ingest path and by a startup/`PUT /settings` backfill. `tasks` search stays keyword-only.
  Full rationale (and why not an external engine / `sqlite-vec`) in `docs/DECISIONS.md`.
- `inboxWatcher.ts` — chokidar watch on `config.inboxDir`. Delegates to `fileExtract.ts` for
  whatever's supported there (text, PDF, images); anything else is logged as skipped, not
  silently ignored. Dedupes on `source_path` so restarts don't reprocess files.
- Document ingestion has three entry points into the same pipeline: `POST /documents/ingest`
  (paste text, JSON body), `POST /documents/upload` (multipart file — PDF/photo/scan, the
  `@fastify/multipart`-backed route), and the inbox watcher above. All three end up at
  `store.createDocument()` + `extractDocument()`. An **uploaded** file's original bytes are
  also kept under `<dataDir>/documents/<userId>/` (MIME in `documents.original_mime`) so
  `GET /documents/:id/original` can serve it for the client-side preview (PDF viewer / image);
  watched-folder documents are served from their on-disk `source_path` instead, pasted-text
  ones have no original (404). `agent-core/src/documentFiles.ts` owns that on-disk store: the
  file is saved under the document's **own filename** (sanitized, extension kept, `" (2)"`
  suffix on collision — recorded in `documents.original_disk_name`), a rename moves it to
  match, and `backfillOriginalDiskNames()` at startup renames any legacy `<docId>`-named
  originals from before this. `resolveOriginalPath()` still falls back to the old `<docId>`
  path so an un-migrated file keeps working.
- `config.ts` — every config value has an env var override; nothing else in the codebase should
  read `process.env` directly. `dataDir` defaults to `$XDG_DATA_HOME/family-agent`
  (`~/.local/share/family-agent`), **not** the repo tree — override with
  `FAMILY_AGENT_DATA_DIR`. The SQLite DB, per-user inbox folders, `settings.json`,
  and cached OCR/ASR models all live under it.

**desktop** (`desktop/`): `src/` is plain TS/HTML/CSS (no framework) built with Vite;
`src-tauri/` is the Rust shell. `main.rs` spawns `agent-core`'s built `dist/server.js` as a child
process via `node`, with `PR_SET_PDEATHSIG` set on the child (Linux, via `libc::prctl` in a
`pre_exec` hook) so a hard-killed parent can't orphan it — this was a real bug, found by testing
`kill -9` against the running app, not defensive-by-default. `src/api.ts` keeps the bearer token
in `localStorage` and attaches it to every request; a `401` clears it and fires
`family-agent:signed-out`, which `main.ts` handles by reloading to the login screen. `main.ts`
gates the whole app behind `boot()` (setup → login → app) and shows a "Family" nav item + admin
machine-settings only when the signed-in user is an admin. The Documents view has a search box
(`#document-search` + a mode `<select>`: Smart/Exact/Typo-tolerant/By meaning) → `searchDocumentsSmart`
via `GET /documents/search?mode=`; empty query shows the full list. See `db.ts` / `embeddings.ts` above.

**android** (`android/app/src/main/kotlin/app/familyagent/android/`): single-Activity Compose
app, `AppViewModel` holds all state as one `StateFlow<AppUiState>` (including `auth: AuthState`,
which gates the UI: `PickServer` → `NeedLogin` → `Authenticated`). `FamilyAgentApi` is a thin
OkHttp + kotlinx.serialization client carrying `authToken`; a `401` throws
`UnauthorizedException`, which `AppViewModel.apiCall {}` catches and turns into
`AuthState.NeedLogin`. `data/ServerDiscovery.kt` finds the master node two ways at once — mDNS
(`NsdManager`, `_familyagent._tcp`, Wi-Fi multicast lock) **and** an active `GET /health` probe
of the device's own /24 plus `10.0.2.2` (the emulator forwards no multicast, and some Wi-Fi
blocks client-to-client mDNS — the probe is what makes discovery actually work in those
cases); `DiscoveryScreen` lists whatever either method finds, plus a manual-address fallback, `LoginScreen` signs in, `SettingsStore` persists the session
(`serverUrl` + `token` + names) in DataStore. From an emulator, `10.0.2.2` is the
alias for the host machine running agent-core. `DocumentsScreen` uploads files via a system
picker (`GetContent`) or camera capture (`TakePicture` + a `FileProvider` — see
`res/xml/file_paths.xml` and the `<provider>` entry in `AndroidManifest.xml`); both paths funnel
into `FamilyAgentApi.uploadDocument()`, an OkHttp `MultipartBody` POST to the same
`/documents/upload` route the desktop upload UI uses. `DocumentsScreen` also has a search field
+ a `SingleChoiceSegmentedButtonRow` (Smart/Exact/Fuzzy/Meaning); search state lives on
`AppUiState` (`documentSearch*`), debounced in `AppViewModel.setDocumentSearch`.

## Native iOS app (`ios/`)

Full feature parity with `android/`, native SwiftUI, **Apple Liquid Glass** on iOS 26 with a
`.ultraThinMaterial` fallback down to **iOS 18**. It's a pure HTTP client of `agent-core` — the
wire types are hand-mirrored in `ios/FamilyAgent/Networking/DTOs.swift` (the counterpart of
`android/.../data/ApiModels.kt`), same no-shared-code discipline as the other clients.

- **Project**: hand-authored `FamilyAgent.xcodeproj/project.pbxproj` using Xcode 16+
  file-system-synchronized groups (`PBXFileSystemSynchronizedRootGroup`, `objectVersion 77`) — no
  per-file references, new Swift files auto-add, builds headless with `xcodebuild`. Deployment
  target iOS 18. One SPM dep: `swift-markdown-ui` (`Package.resolved` committed). `Info.plist` +
  `.entitlements` live in `ios/Config/` **outside** the synchronized group (inside it, Xcode both
  copies *and* processes `Info.plist` → "multiple commands produce" build failure). Bundle id
  `app.familyagent.ios`. Fonts (Inter + Source Serif) copied from `android/.../res/font/`.
  **ATS is fully off** — `NSAppTransportSecurity` = `NSAllowsArbitraryLoads` and *nothing else*
  (adding `NSAllowsLocalNetworking` back makes iOS 10+ ignore it). Required: the app only ever
  talks plain http to a server the user runs and points it at, and `NSAllowsLocalNetworking`
  doesn't cover the `100.64/10` range Tailscale hands out. `NSBonjourServices` /
  `NSLocalNetworkUsageDescription` are unrelated keys (mDNS discovery) and stay.
- **State**: `ios/FamilyAgent/App/AppModel.swift` — one `@MainActor @Observable` object mirroring
  Android's `AppUiState` (same field names) + `AppViewModel`'s methods, split across
  `AppModel+{Chat,Messages,Data}.swift`. `perform<T>` wraps every call and turns a `401` into
  `.needLogin` (= `AppViewModel.apiCall`). Builds clean under Swift 6
  `SWIFT_STRICT_CONCURRENCY=complete`.
- **Networking**: `FamilyAgentAPI.swift` (a `Sendable` struct over `URLSession`, ~90 methods,
  `// MARK:` per Android grouping — diffs 1:1 against `FamilyAgentApi.kt`). Two payloads send an
  explicit JSON `null` via a custom `encode(to:)` (`RescheduleTaskRequest`,
  `RoutineInput.deliverChannelId`) — `JSONEncoder` omits `nil` otherwise. `ToolStep.input` is a
  `JSONValue` enum. `ServerDiscovery.swift` = `NWBrowser` (`_familyagent._tcp`, needs
  `NSBonjourServices` + `NSLocalNetworkUsageDescription` in Info.plist) **plus** an active
  `GET /health` probe of the device /24 (`getifaddrs`) that **loops** (the first pass trips
  the Local Network permission prompt, so a one-shot probe finds nothing on a fresh install);
  the simulator also probes `localhost`. `DiscoveryView` also has a **"Scan QR code"** button
  (`Features/Auth/QRScannerView.swift`, an `AVCaptureSession` reader) — the desktop Settings
  "Pair a phone" section shows a QR of one of the server's reachable addresses
  (`agent-core` `/health.lanAddrs` = `{url, kind}[]`, `kind` ∈ `tailscale`/`lan`/`other`,
  Tailscale first — MagicDNS name (`tailscale status --json`, best-effort) then `100.x` IP —
  because it works off-Wi-Fi; `src/lan.ts`; desktop `src/qr.ts`, a clickable list picks which
  address the QR encodes) — and, with the panel's "sign in automatically" toggle on
  (default), a single-use pairing token so the scan needs no password (see "QR phone
  pairing" above; `PairingPayload` parses the `{url,name,t}` envelope).
  Token in the Keychain (`Keychain.swift`), rest in `UserDefaults` (`SettingsStore.swift`).
- **Design** (`ios/FamilyAgent/DesignSystem/`): `Theme.swift` ports the Kotlin `Pal`/`AppAccents`/
  shape/type tokens (warm `#F6F5F4`, one `#0075DE` accent, Inter, light only). `Glass.swift` is
  the single `#available(iOS 26, *)` shim — `.glass(_:in:)` / `.glassButton()` →
  `glassEffect`/`.buttonStyle(.glass)` on 26, `.ultraThinMaterial` + hairline below. `AppCard`
  stays opaque white on both (crisp text over the gradient). `Atmosphere.swift` is the
  `TimelineView`+`Canvas` port of `ui/Atmosphere.kt` (4 drifting blooms, 34 s loop, frozen under
  Reduce Motion). `Components.swift` = `ScreenScaffold` / `AppCard` / `Chip` / `StatusDot` /
  `CopyButton` / `SpeakButton` / `TypingDots` / `StepsStrip` / `FlowLayout` / `stepVerb`.
  `Markdown.swift` themes `swift-markdown-ui` (inline styles only — its block builders can't call
  `@MainActor` view modifiers under strict concurrency).
- **Navigation**: `MainShell.swift` mirrors Android's `ModalNavigationDrawer` — Chat is the home
  surface, a **drawer slides in over the content** (scrim + edge-swipe + a floating hamburger
  button, top-left) to switch views, then dismisses. No app bar (Android parity); each screen
  carries its own header (`ScreenScaffold` title, or an inline row for Chat's new/history and
  Events' `+`). `AppDrawer` = logo + wordmark + nav items with an `accent-soft` pill behind the
  active one + a connection pill pinned to the footer. 12 `Destination`s, health-gated the same
  way (`routinesEnabled`, `skillsMode`, `mcpMode && admin`, `vaultMode`). Each destination is
  its own `NavigationStack` (nav bar hidden) so per-screen `.sheet` / `navigationDestination`
  (Messages → Conversation, which hides the menu button) keep working. Chat sessions + tool
  webview are `.sheet` / `.fullScreenCover`.
- **Screens**: one file per Android screen under `ios/FamilyAgent/Features/<X>/`. Calendar math
  (`Tasks/CalendarMath.swift`) hard-codes a Monday-start `Calendar` like `mondayOf` on Android
  (don't trust device locale). `Board/BoardView.swift` positions notes in points (dp ≈ pt, 1:1),
  `PATCH`es `{x,y}` optimistically on drag end. `Shared/CardWebView.swift` seals a generated card
  in a `WKWebView` (`loadHTMLString(html, baseURL: nil)` opaque origin + a `WKContentRuleList`
  block-all + a `@MainActor` nav-policy deny). `Shared/PDFPreview.swift` uses PDFKit.
  `Audio/VoiceRecorder.swift` = `AVAudioEngine` tap → `AVAudioConverter` → 16 kHz WAV, same RMS
  constants as `VoiceRecorder.kt` / `desktop/src/audio.ts`; `HoldToTalkMic.swift` is the
  tap-to-dictate / hold-for-push-to-talk gesture.
- **DEBUG-only smoke-test hooks** (`AppModel.restoreSession` / `MainShell` / `ChatView`):
  `FA_SERVER_URL`, `FA_AUTOLOGIN=user:pass`, `FA_START=<destination>`, `FA_CHAT_PROMPT` — pass as
  `SIMCTL_CHILD_*` env to `xcrun simctl launch`.

See `ios/README.md` and `docs/DECISIONS.md` → "Cloning the Android app to native iOS".

## Cross-account: chat + shared board

The first data that isn't per-account. Both added narrowly rather than by loosening
`ScopedStore` (full reasoning in `docs/DECISIONS.md`):

- **Chat** — `channels` / `channel_members` / `messages` tables on the base `Store`
  (not `ScopedStore`). Every read method takes the requesting user id and returns
  nothing when they aren't in `channel_members`. `findOrCreateDm` is idempotent per
  unordered pair; groups have a name. Routes: `GET/POST /channels`, `GET
  /channels/:id`, `DELETE /channels/:id` (any member — removes it for everyone),
  `GET/POST /channels/:id/messages`, `POST /channels/:id/members`,
  `POST /channels/:id/read`, `GET /family/members` (any authed user, name + username
  only — *not* the admin `/users`). The assistant chimes in on **`@agent`/`@ai`**
  (`mentionsAgent()` → `askFamilyAgentInChannel()`, planner + transcript context)
  **or a leading `/` command** (`parseForcedAgentCommand()` → `runForcedAgentTurn()`,
  one specialist directly, no planner) — the same two triggers as the 1:1 `/chat`,
  so the agent behaves the same wherever you talk to it. `runForcedAgentTurn()` (in
  `server.ts`) is the shared dispatch both routes use. `resolvePendingAgentMessage()`
  fills in the `_agent_` placeholder row; clients poll. A message can carry image
  attachments (`messages.images`, JSON array of data URIs) exactly like `POST /chat`.
  Desktop: `#view-messages` in `main.ts` — the composer is wired with the SAME
  `wireAutoGrow` / `wireSlashMenu` / `wireMic` / `makeImageTray` helpers as the
  Chat composer (one-line→three auto-grow + expand button, `/` autocomplete, voice
  input). Android: `Destination.Messages` + nested `conversation/{id}` route,
  `MessagesScreen.kt`, poll loop in `AppViewModel`.
- **Sticky board** — `sticky_notes` on `ScopedStore`: `scope='private'` is
  `AND user_id = ?`, `scope='shared'` is open to every member (author tracked in
  `user_id`). Routes `GET/POST /notes`, `PATCH/DELETE /notes/:id`. Subagent
  `notes-agent` (`agents/noteTools.ts`: `list_sticky_notes`, `add_sticky_note`).
  Desktop `#view-board`; Android `Destination.Board` / `BoardScreen.kt`.
- **Chat references** — the retrieval tools take an optional `onReference` hook
  (`agents/references.ts`); `server.ts` collects per `/chat` turn and returns
  `references: [{type,id,label}]`. Clients open the item in a side panel (desktop)
  / bottom sheet (Android), also reused by the document Preview button. `GET
  /tasks/:id` and `GET /documents/:id` back it. For a PDF/image document the panel
  shows the actual file, not just the extracted text: desktop renders PDFs with
  pdf.js (`desktop/src/pdfPreview.ts` — the Linux webview has no built-in PDF
  viewer, so an `<iframe>` won't do), Android with the platform `PdfRenderer`
  (`android/.../ui/PdfPreview.kt`); both fetch `GET /documents/:id/original`.

## Chat history sessions (private assistant chat)

The 1:1 assistant chat (`POST /chat` — not family chat above) persists as named,
resumable sessions, per-user like tasks/documents (`chat_sessions` / `chat_messages`
on `ScopedStore`, **not** the cross-account `channels`/`messages` shape — a private
chat has no membership concept). A session is created **lazily**: `POST /chat` with
no `sessionId` creates one titled from the first message (plain truncation to ~60
chars, no model call — see `docs/DECISIONS.md`-style reasoning in the git history if
you're wondering why not an AI-generated title) and hands its id back in the
response; the client holds onto it for the rest of that conversation. Resuming a
session actually restores conversational memory, not just a saved transcript: the
route loads the session's prior messages (capped at the last ~20) and passes them as
`history` to `askFamilyAgent()` (`agents/index.ts`), which prepends them to the
`messages` array — text only, no replayed images, to keep an already-slow CPU turn
from growing. Routes: `GET /chat/sessions`, `GET /chat/sessions/:id/messages`,
`PATCH /chat/sessions/:id` (rename), `DELETE /chat/sessions/:id`. Both clients turn
the Chat view into a list+detail layout reusing the Messages view's pattern: desktop
`#view-chat`'s `.session-pane` (`main.ts`, styled off `.channel-pane`/`.channel-row`);
Android a "History" button on `ChatScreen` navigating to `ChatSessionsScreen.kt`
(`chatsessions` route, not a drawer `Destination`), reopening a row loads that
session's messages back into the same `ChatScreen` via `AppViewModel.openChatSession`.

**Tool-call visibility.** Every tool the agent calls in a turn (including a
subagent's) is captured by a `StepRecorder` (`agents/steps.ts`, a LangChain
`BaseCallbackHandler` passed to `agent.invoke`) and shown under the reply as a
live strip; clicking it opens the side panel with each call's exact arguments
and result. Live transport is a client-supplied `turnId` on `POST /chat` + an
in-memory turn map polled via `GET /chat/turns/:turnId` (the family-channel
`@agent` reply reuses the pending message id as the turnId). The final `steps`
are persisted on `chat_messages.steps` / `messages.steps` (JSON, like `refs`)
for replay. **Vault turns pass no recorder** — a step output would leak the
secret. Desktop `makeStepsStrip`/`openStepsPanel` in `main.ts`; Android
`StepsStrip` in `ui/Components.kt` + `DetailContent.Steps`. See
`docs/DECISIONS.md` → "Tool-call visibility".

**Generated HTML cards (`render_card`).** When `config.cardsEnabled` (the first
**boolean toggle in the desktop Settings page**, admin-only, persisted; env
`FAMILY_AGENT_CARDS=0` forces off + env-locks; `/health.cards`), the assistant
has a leaf `render_card({ title, html })` tool (planner + document/research/
connections subagents) — it answers with a small self-contained HTML/JS
snippet (a chart, checklist, diagram) the clients embed inline. The snippet
runs in an `<iframe sandbox="allow-scripts">` (**no** `allow-same-origin` =>
opaque origin, no app/localStorage access) with a `default-src 'none'`,
no-`connect-src` CSP (no network at all). Server stores only the fragment
(`chat_messages.cards` / `messages.cards`, JSON) and wraps it — CSP + a trimmed
`HOUSE_STYLE` + a `CARD_RUNTIME` (measurement + error trap + a small `Card`
SVG-chart helper) — at read time (`cards/wrap.ts`). Per-user `chatCards`
collector like `chatRefs`; capped 2/reply. Android renders it in an isolated
`WebView` (`loadDataWithBaseURL(null, …)`, all network blocked,
`@JavascriptInterface postHeight`). Desktop `renderCard` in `main.ts` +
`.chat-card` CSS; Android `ui/CardWebView.kt` + `DetailContent.CardSource`.
Tests: `test/cards.test.ts`. See `docs/DECISIONS.md` → "AI-generated HTML cards".

**Full-page artifacts (`render_artifact`).** The card's bigger sibling. When
`config.artifactsEnabled` (**on by default, `FAMILY_AGENT_ARTIFACTS=0`
disables** — env-only, no Settings toggle, since it adds no trust boundary the
card sandbox didn't; `/health.artifacts` = `"on"|"off"`), the assistant has a
leaf `render_artifact({ title, html })` tool (same placement as `render_card`:
planner + document/research/connections subagents). It generates a **whole
page** — a walkthrough, an interactive explainer, a dashboard — persisted
per-user in the **`artifacts` table on `ScopedStore`** (8-char `shortId`,
`title`, `html` fragment ≤ 128 KB, `source`/`source_id`). `artifacts/wrap.ts`
wraps the stored fragment at read time (doctype + the **same** sealed
`default-src 'none'` no-`connect-src` CSP + opaque-origin sandbox as a card +
the full `HOUSE_STYLE` page look + the shared `CARD_RUNTIME`). Routes:
`GET /artifacts` (list, no html), `GET /artifacts/:id` (raw `html` + wrapped
`document`), `PATCH /artifacts/:id` (rename), `DELETE /artifacts/:id`. The
reply links to one via a **new `ChatReference` type `artifact`** (`id` = the
artifact id) — `render_artifact` calls `onReference` and it rides the existing
`chatRefs` → `resolveReferences` → persisted `refs` pipeline, so no new
response field. Each client has an **Artifacts tab** (next to Tools,
`/health.artifacts`-gated) with a list + a sealed full-size viewer, and the
reply's `artifact` chip opens it: desktop `#view-artifacts` (`main.ts`,
`.artifact-*` CSS, `<iframe sandbox="allow-scripts">`), iOS
`Destination.artifacts` → `ArtifactsView` + `ArtifactViewerView` (a
fullScreenCover from the chip), Android `Destination.Artifacts` →
`ArtifactsScreen` + `ArtifactViewScreen` (a nested `artifactview/{id}` route),
both reusing the `CardWebView` isolation full-size. No export, channel-sharing,
or `/artifact` forced turn. Tests: `test/artifacts.test.ts`.

**Highlight-and-comment on an artifact.** Select text in the sealed viewer,
leave a note, press **Ask AI** → an off-planner model call
(`artifacts/resolve.ts`, `extraction.ts` pattern: two closure-bound tools,
`edit_artifact({ html })` once + `resolve_comment({ commentId, reply })` per
comment, validated with one retry) either edits the page or replies; an
unaddressed comment stays open ("skipped"). `artifact_comments` on
`ScopedStore` (scoped *through* the owning artifact), text-quote anchored
(`quote` + `prefix`/`suffix`, re-located + `<mark>`-wrapped by
`ARTIFACT_RUNTIME` = `CARD_RUNTIME` + an annotation IIFE). Editing keeps **one**
prior version (`artifacts.prev_html` / `revision`); `POST
/artifacts/:id/revert` is the one-step undo. The viewer↔page bridge is the same
three-transport shape as the card height report (`postMessage` / WKScriptMessage
/ `@JavascriptInterface`), carrying only strings. Routes: `GET/POST
/artifacts/:id/comments`, `PATCH/DELETE …/:cid`, `POST
/artifacts/:id/resolve-comments`, `POST /artifacts/:id/revert`. All three
clients: a comments rail (desktop) / bottom sheet (mobile) beside the viewer.
`wrapArtifact(a, comments)` now takes the comment list (seeds
`window.__ARTIFACT_COMMENTS`; host re-pushes via `window.__artifactApi`).
Tests: `test/artifactComments.test.ts`. See `docs/DECISIONS.md` →
"AI-generated full-page artifacts" → "Follow-up: highlight-and-comment".

## "/" forces a chat turn to one specialist agent

The planner's own decision to delegate to a subagent (see `PLANNER_PROMPT`'s
worked examples above) is unreliable on a small model — the same class of
misrouting documented elsewhere in this file. A leading `/` on a 1:1 chat
message skips that decision entirely and routes straight to one specialist,
guaranteed structurally rather than by a stronger prompt:
`parseForcedAgentCommand()` (`agents/index.ts`, next to `mentionsAgent()`)
reads the word right after `/` — `build`→builder, `task`→task, `find`/`search`
(alias)→document, `note`→notes, `schedule`/`remind` (alias)→routine,
`web`/`lookup`→research, `run`/`shell`→workshop, `calc`/`compute`→calc,
`skill`→skill, `connect`/`mcp`→connect — and
returns `{ kind, text }`; anything else (a tool name, or nothing) still means
`kind: "tools"`, the original behavior, so a plain `/ItemTracker …` message is
unaffected by the recognized keywords existing. Each `kind` has its own
standalone builder — `buildFamilyToolsAgent`/`buildFamilyTaskAgent`/
`buildFamilyDocumentAgent`/`buildFamilyBuilderAgent`/`buildFamilyNotesAgent`/
`buildFamilyRoutineAgent`/`buildFamilySkillAgent`/`buildFamilyConnectionsAgent`
— a `createDeepAgent` instance with *only* that one
subagent's own tools bound (no `subagents` array, same permissions/middleware
as the planner), so it structurally cannot route anywhere else.
`buildFamilyBuilderAgent` shares `makeBuilderTools()` with the planner's own
builder-agent subagent rather than duplicating those three tool definitions.

`server.ts` keeps one `makeAgentCache()`-built cache per kind (the planner plus
one per forced kind — the five original subagents plus `routine`, `research`,
`workshop`, `calc`, `skill`, `connect`) instead of hand-rolled `Map`s;
`dropAgents(userId)`/
`dropAllAgents()` touch all of them in lockstep at every call site that changes
what an agent can do (a tool build/improve/delete, or a model-client
rebuild). Both `POST /chat` AND `POST /channels/:id/messages` run a `/` command
through the shared `runForcedAgentTurn()` helper (in `server.ts`), so the
assistant behaves the same in a private chat or `@`-mentioned in a
conversation. A `kind: "tools"` command additionally checks `config.toolsEnabled`
(no model call, a plain "Tools aren't turned on for this server." reply, if off
— the other kinds check their own capability flag, e.g. `calc` needs
`config.computeEnabled`). The stored chat message always keeps the leading `/`
(an honest transcript); only the model-facing text is stripped. An empty `text` (just `/build` with nothing after) gets a
per-kind fallback prompt (e.g. "List my tasks.") rather than an empty
message.

Both clients turn `/` into a Slack-style autocomplete merging two sources:
a small fixed list of the command keywords (kept in sync by hand with
`FORCED_AGENT_KEYWORDS` — desktop's `SLASH_COMMANDS` in `main.ts`, Android's
`SLASH_COMMANDS` in `ChatScreen.kt`; desktop hides the capability-gated ones —
`web`/`run`/`calc`/`skill`/`connect` — off `/health`, Android lists them all)
and the already-fetched tool list
filtered to `kind === "server" && status === "ready"` (a `kind === "static"`
tool has no operations to call via this path at all — see
`familyToolCatalog` in `server.ts` — so it's excluded; no new endpoint
needed). Desktop: `#chat-slash-menu` / `#message-slash-menu` in `main.ts`,
keyboard nav (arrows/Enter/Escape). **Picking a row — or typing `/name ` with a
trailing space — lifts the command out of the textarea into a chip**
(`.composer-chip`, `#{chat,message}-slash-chip` inside a `.composer-field`
wrapper); the textarea then holds only the message. Backspace at caret 0
deletes the whole chip at once (never a half "/comman"). On submit the wire
form is rebuilt as `/${cmd} ${text}` (and shown that way in the transcript
bubble, keeping the wrench flag). All of this lives in the shared
`wireSlashMenu(input, menu, chip, form, onChange, { mention? })` helper — Chat
and Messages call it the same way. In **Messages only** (`{ mention: true }`)
the same chip + autocomplete plumbing also handles **`@agent`** (aliases `@ai`
/ `@assistant`): typing `@agent ` or picking it from the `@` popup lifts an
`@agent` pill exactly like a `/` command, mutually exclusive with a slash chip;
on submit the body is rebuilt as `@agent ${text}` and `mentionAgent: true` is
sent. On Android the same pill + `@` popup lives in `ConversationScreen`'s
composer (`MentionChip`, `MENTION_LIFT`), a backspace-on-empty drops it whole.
A "?" button (next to "+ New" in Chat, in the
conversation head in Messages) opens the reference-preview side panel
(`openSidePanel()`) with the same list explained. Android: `ChatScreen.kt`
renders matches as a card above the composer (the `input` state is a
`TextFieldValue`, not a plain `String`, specifically so a programmatic
insert — this, and the voice-transcript fill — can place the cursor at the
end via `endOf()`; a plain-`String` `TextField` resets the cursor to the
start on that kind of recomposition, a real bug caught by testing the picker
against a live emulator, not by inspection); a help icon opens a
`ModalBottomSheet` (`SlashHelpSheet`, same pattern as `DetailSheet.kt`) with
the same content. Both clients also flag a `/`-prefixed user bubble with a
small wrench icon so it's obvious at a glance which turns skipped the
planner — read directly off the message text (`startsWith("/")`), so it
renders correctly when replaying stored session history too, not just for a
message just sent.

## Scheduled routines

A **routine** is a per-user saved instruction the assistant runs on a schedule
(a morning briefing, a bill nudge, a weekly review, a one-off future reminder) —
the app's first *push* surface. `agent-core/src/routines.ts` owns the trigger
math and the runner:

- **Trigger** — `cron` (hand-rolled 5-field parser + next-run in **local time**,
  `* / , - */n`, Vixie dom-or-dow rule), `once` (a one-shot future datetime), or
  `every` (a plain minute interval). Clients + the NL tool send *friendly* fields
  (`dailyAt` / `weeklyOn`+`weeklyAt` / `monthlyDay` / `onceAt` / `everyMinutes` /
  `cron`); `parseTriggerInput()` canonicalises + validates. `describeTrigger()`
  is the human sentence shown in the UI and echoed by the agent.
- **Action** — `{ agent, instruction }`; `agent` ∈ `planner` | `task` |
  `document` | `notes` | `tools` | `research` (web on) | `connect` (MCP on).
  **`builder` and `workshop` are not valid values** — a routine
  never generates or rewrites code unattended. Enforced structurally: the zod
  enum omits it and `runRoutineAction` (`server.ts`) has no branch for it. A
  local model + a fixed agent set means a scheduled run can't exfiltrate or take
  an unbounded action.
- **Delivery** — every run writes a `routine_runs` row (output / error / status)
  + an `activity` line (`actor: "routine"`); the Routines screen is the home for
  output. Optionally also posted into a family channel as `@agent`
  (`deliverChannelId`, membership-checked — reuses the `_agent_` message
  plumbing).

**`RoutineScheduler`** is process-wide (one, like `ToolSupervisor`), started
only by `main()` (`buildServer(..., { startRoutineScheduler: true })`; tests
drive `app.routineScheduler` by hand). A `FAMILY_AGENT_ROUTINE_TICK_MS` (60s)
tick reads `store.dueRoutineIds()` into a **serialized queue** — the model is
single-threaded and a planner turn can take ~110s, so runs must not stack. The
schedule is advanced *before* a run is enqueued (a slow/crashing run still moves
the clock; a spent `once` is disabled by `execute()` after the run, not before,
so an already-queued job isn't skipped as "disabled"). **Catch-up**: on
`start()`, `reconcile()` computes any missing `next_run_at` and, for a trigger
that came due while the process was down, either runs it once now (a `once`, or
`catchUp: "run"` within `FAMILY_AGENT_ROUTINE_CATCHUP_MS`, default 6h) or skips
it forward. `FAMILY_AGENT_ROUTINES=0` disables the feature (routes 404,
`/health.routinesEnabled` false, clients hide the screen).

DB: `routines` / `routine_runs` on `ScopedStore` (per-user CRUD + run history)
plus `Store.allEnabledRoutineIds()` / `dueRoutineIds()` / `failStaleRoutineRuns()`
for the scheduler. Routes: `GET/POST /routines`, `GET/PATCH/DELETE /routines/:id`,
`GET /routines/:id/runs`, `POST /routines/:id/run` (runs now, awaits like
`/chat`). Authoring: the `routine-agent` subagent (`agents/routineTools.ts` —
`current_datetime` exists because agents are cached and a stale module-constant
date would break "tomorrow at 9") and the `/schedule` (alias `/remind`) forced
turn. Both clients are thin CRUD screens over `/routines` — the friendly
schedule fields (`dailyAt`, `weeklyOn`, …) map 1:1 to the server's
`RoutineTriggerInput` and `decompose()` reverses a stored trigger for editing.
Desktop: `#view-routines` in `main.ts` (`renderRoutines` + the create/edit
form). Android: `Destination.Routines` + `RoutinesScreen.kt` (the card list +
a `ModalBottomSheet` form; drawer item gated on `/health.routinesEnabled`).
See `docs/DECISIONS.md` → "Scheduled routines" for the v2+ cuts (data-relative
+ event triggers, OS notifications).

## Web + shell capabilities (research-agent, workshop-agent)

Two capabilities that extend the agent past the local box, each **off by
default**, each reported in `/health` (`web`, `shell`) so clients show/hide the
`/web` and `/run` slash commands.

**Web is admin-toggleable from the app now** (as of 2026-09-10 — it was
previously env-var-only). All three clients have an "Internet access" section in
Settings: a provider picker (Off / DuckDuckGo — keyless / SearXNG + URL / Tavily
or Brave + API key) that writes `webSearchProvider` / `webSearchUrl` /
`webSearchApiKey` through `PUT /settings` (admin-only, persisted in
`settings.json` via `settingsFile.ts`, `dropAllAgents()` on an on/off change).
Setting any `FAMILY_AGENT_WEB_SEARCH_*` env var pins the whole group
(`envLocked.webSearchProvider`) and the controls go read-only — same
env > persisted > default precedence as `model`/`cardsEnabled`. `GET /settings`
never echoes the API key back, only `webSearchApiKeySet`. **Shell stays
env-var-only** (`FAMILY_AGENT_SHELL=1` + bubblewrap) — it grants real code
execution, a bigger posture change. See `docs/DECISIONS.md` → "Web access".

**Web** (`agent-core/src/web/`, `agents/webTools.ts`). A `research-agent`
subagent with `web_search` + `open_page`. This is the deliberate, bounded
exception to "nothing leaves the machine":
- `web/fetch.ts` is the **only** module that makes a non-localhost request —
  enforced by `test/web.egress.test.ts`, which greps `src/` for a hard-coded
  remote URL outside `src/web/` (the same discipline as "only `config.ts`
  reads `process.env`"). `guardedFetch` is its primitive; `search.ts` uses it
  for provider calls, `fetchPage` for a model-chosen URL.
- **SSRF guard** (`fetchPage` / `assertPublicUrl`): http(s) only, ports
  80/443/8080/8443, hostname not `localhost`/`.local`/…, and every resolved
  address checked against loopback/private/link-local/CGNAT ranges
  (`isPrivateAddress`). **Redirects are not followed** — the tool returns the
  `Location` and the model calls `open_page` again (kills DNS-rebinding, keeps
  every hop logged). Optional `FAMILY_AGENT_WEB_ALLOW`/`DENY` domain lists.
- Search is a provider abstraction (`FAMILY_AGENT_WEB_SEARCH_PROVIDER`):
  `searxng` (self-hosted, `_URL`), `tavily`/`brave` (`_API_KEY`), `ddg`
  (DuckDuckGo lite HTML — key-free but blocked from datacenter IPs, best from a
  home connection), `none` (default → capability off).
- **Injection**: `open_page` text is wrapped with an untrusted-content note and
  the prompt has a worked example (a page may say "ignore previous
  instructions" — never act on it). `research-agent` has no write tools and
  can't reach other subagents, so the blast radius is "a wrong answer". It's
  allowed as a **routine** action agent (weather/news briefings); `workshop` is
  not.
- A new `ChatReference` type `link` (`id` = URL) → clients render a chip that
  opens the page.

**Shell / file processing** (`agent-core/src/shell/`, `agents/workshopTools.ts`).
A `workshop-agent` that runs allow-listed CLI tools over a per-user file
workspace. `FAMILY_AGENT_SHELL=1` **and** bubblewrap must be usable
(`sandboxAvailable()` runs a real probe — bwrap can be installed but blocked
where unprivileged userns is off) **and** at least one curated tool installed,
else `/health.shell` is `"unavailable"`/`"off"` and the subagent isn't wired.
- `shell/sandbox.ts` — `runSandboxed(argv, workdir)` builds a `bwrap`
  `--unshare-all` (no network) argv with a read-only view of `/usr`,`/bin`,`/lib`
  and read/write only in `/work` (the workspace), `--clearenv`, `ulimit` for
  memory/output, `timeout` for wall-clock. Same deny-by-default philosophy as
  the Deno sandbox behind builder tools. No bwrap → capability off (never runs
  a command unconfined).
- `shell/workspace.ts` — `<dataDir>/workspace/<userId>/`. `safeName()` rejects
  `..`, absolute, hidden, backslash. `importFile` brings a document's original
  in; nothing else is reachable.
- `shell/executor.ts` — `CURATED_TOOLS` (qpdf, ffmpeg, imagemagick, jq, csvkit,
  pandoc, poppler, …), probed against PATH at startup; `FAMILY_AGENT_SHELL_ALLOW`
  adds more. `runTool(userId, tool, args[])` — **no shell**, `args` is an argv
  array, path-looking args must stay in the workspace. `run_shell` (arbitrary
  bash, still sandboxed) only when `FAMILY_AGENT_SHELL_UNRESTRICTED=1`.
- Tools: `list_workspace`, `list_tools`, `import_document`, `read_text_file`,
  `run_command`, `save_output` (→ documents, via the same ingest pipeline as
  `POST /documents/upload`, or → the watched folder), `clear_workspace`.
- Not a routine action agent (unattended file processing has no one to confirm).

`server.ts` wires both via `webDeps(userId)` / `shellDeps(userId)` (which
provide `logActivity` + the `saveAsDocument`/`saveToInbox` closures), guarded by
`webEnabled()` / a one-time `shellReady` probe. `runRoutineAction` gained a
`research` branch. `ForcedAgentKind` gained `research` (`/web`, `/lookup`) and
`workshop` (`/run`, `/shell`).

## Code sandbox: `run_code` (compute/*)

A stateless "run this snippet, give me the answer" tool — `agent-core/src/compute/run.ts`,
`agents/computeTools.ts`. A 2B model does arithmetic / date math / small data
analysis wrong in its head; `run_code` runs a JavaScript snippet and returns an
exact result.

- **Runtime**: QuickJS compiled to WebAssembly (`quickjs-emscripten`) — ~1 MB,
  ships the `.wasm` in the npm package, loads in plain Node `WebAssembly`, **no
  native dependency, no build step**, cross-platform (desktop is Mac/Windows
  too). The module has **zero syscalls** — no filesystem, network, process,
  clock, or randomness. Isolation is structural, not a policy.
- **Caps**: memory (`setMemoryLimit`, 64 MB), stack, wall-clock 3 s via
  `setInterruptHandler` — which fires from inside the interpreter loop **and the
  regex engine** (verified: catastrophic backtracking is stopped), and returned-
  value size. A fresh runtime + context per call → no state leaks between calls.
- **Shape**: `run_code({ code, input? })` → `{ result, logs, error, limitHit }`.
  `input` (any JSON) is the global `input`; the current time is the ISO string
  `NOW` (injectable for deterministic tests). The snippet's **last expression**
  is the result (Node-REPL model — a top-level `return` errors); `console.log`
  is captured into `logs`. A preamble sets these up on `globalThis` and ends
  with a bare `undefined;` so an all-declarations snippet yields `result:
  undefined` rather than leaking a preamble value.
- **Where**: bound **directly** onto the planner and `document-agent` (compute
  a value read off a bill) — it's a leaf capability, not a domain, so no
  subagent. Also a `/calc` (alias `/compute`) forced turn → `buildFamilyCalcAgent`.
- **On by default** (`FAMILY_AGENT_COMPUTE=0` disables; `/health.compute`
  boolean). Unlike web/shell this changes no security posture — it's a pure
  function — so it isn't an admin-gated switch. `warmCompute()` pre-loads the
  wasm at startup.
- Tests: `test/compute.test.ts` (13 — result/logs/input/NOW, error reporting,
  every cap enforced, no ambient globals, no state leak).

## Skills and MCP (skills/*, mcp/*, skill-agent, connections-agent)

Two extension points that don't need code in `agent-core`. Both use the
`tools-agent` "enumerate then call" shape so a 2B model isn't holding every
skill body / MCP tool in its prompt. Full rationale: `docs/DECISIONS.md` →
"Skills and MCP".

**Skills** (`agent-core/src/skills/`, `agents/skillTools.ts`). A skill is a
folder `<dataDir>/skills/<name>/` with a `SKILL.md` (forgiving `key: value`
front-matter — `name` / `description` / `when_to_use` / `enabled` — + a
markdown body) and an optional `scripts/` dir.
- `skills.ts` owns the folder store (`listSkills` / `getSkill` / `saveSkill` /
  `setSkillEnabled` / `deleteSkill`; `saveSkill` synthesises front-matter if
  the markdown lacks it). `runScript.ts` runs a bundled `.py`/`.js`/`.mjs`/
  `.sh`/`.bash` script via `shell/sandbox.ts`'s `runSandboxed` with the skill
  folder read-only at `/skill` (new `extraRoBinds` option) — no network,
  read-only system, same as `workshop-agent`.
- Planner tools: `list_skills` (cheap, stays in the always-loaded tool list),
  `use_skill(name)` (loads one body into the turn), `run_skill_script`.
  `PLANNER_SKILLS_SECTION` appended only when `config.skillsEnabled`
  (**default on** — text carries no new trust boundary). `/skill` forced turn
  → `buildFamilySkillAgent`.
- `agents/skillgen.ts` — `generateSkillMarkdown(model, {name, description})`,
  one `extractionModel` call, output reviewed before save (same off-planner
  pattern as `agents/rename.ts`). Route: `POST /skills/draft`.
- Routes: `GET /skills`, `GET /skills/:name`, `POST /skills` (admin),
  `PATCH /skills/:name` (admin, enable toggle), `DELETE /skills/:name` (admin),
  `POST /skills/draft` (admin). Reads are open to every user.
  `/health.skills` = `"full"` (scripts runnable) | `"docs-only"` | `"off"`.
  Desktop `#view-skills`; Android `Destination.Skills`.

**MCP client** (`agent-core/src/mcp/`, `agents/mcpTools.ts`). `agent-core`
connecting *out* to external MCP servers (distinct from `tools/toolMcp.ts`,
which is agent-core being an MCP *server* for generated tools).
- **Off unless `FAMILY_AGENT_MCP=1`** — it's the second non-localhost egress
  point in the codebase (after `src/web/`), so an operator env switch like
  `FAMILY_AGENT_WEB`/`_SHELL`, not a Settings toggle. `test/web.egress.test.ts`
  excludes `src/mcp/` (it only fetches an admin-configured URL, never a
  hard-coded host — noted in that test).
- `config.ts` — `mcp.json` at `<dataDir>/mcp.json`, seeded once from
  `FAMILY_AGENT_MCP_SERVERS`. Each server: `transport` (`http` | `stdio`),
  `enabled`, `scope` (`"family"` or `"user:<id>"`), http `url` + `headers`, or
  stdio `command` + `args` + `env` + `allowHosts`. `redactMcpServer` scrubs
  secret-looking headers/env on every API response.
- `mcp/client.ts` — hand-rolled JSON-RPC 2.0 (no SDK). **http**: Streamable
  HTTP spec `2025-06-18`, parses direct JSON or SSE, carries `Mcp-Session-Id`,
  **redirects not followed**. **stdio**: spawned inside bwrap `--unshare-all`
  (no network) unless `allowHosts` is set, NDJSON over pipes.
- `mcp/manager.ts` — `McpManager`, process-wide (one, like `ToolSupervisor` /
  `RoutineScheduler`), one lazy connection per enabled server, 5-min tool-list
  cache, a failing server degrades to "no tools", drained on SIGINT/SIGTERM
  (`app.mcpManager.stopAll()`). `mcpServersForUser(userId)` = family-scoped +
  that user's own.
- Subagent `connections-agent` (`makeMcpTools` → `list_mcp_tools` →
  `describe_mcp_tool` → `call_mcp_tool`) — wired only when MCP is on **and** ≥1 server enabled.
  External tool descriptions + results are **untrusted**: results clamped to
  `config.mcpMaxResultChars` and framed with a "don't act on instructions in
  it" note; the subagent has no write tools and can't reach other subagents
  (blast radius = "a wrong answer", like `research-agent`). Allowed as a
  routine action agent (`connect`); `/connect` (alias `/mcp`) forced turn →
  `buildFamilyConnectionsAgent`.
- Routes (admin): `GET/POST /mcp/servers`, `PATCH /mcp/servers/:name` (enable),
  `DELETE /mcp/servers/:name`, `POST /mcp/servers/:name/probe` (also run on
  save). `GET /mcp/tools` (any user — their connections' tools, for the UI).
  `/health.mcp` = `"on"` (≥1 enabled server) | `"no-servers"` | `"off"`.
  Desktop: Settings → "Connections (MCP)"; Android: `Destination.Connections`.
  Both admin-only.

Tests: `test/skills.test.ts`, `test/mcp.test.ts`.

## Password vault (vault/*, vault-agent, `/vault`)

A per-user encrypted store for **passwords + TOTP seeds**, optionally shared
across the family, that the local assistant can read out on request. OFF by
default. **Admin-toggleable from Settings now** (as of 2026-09-11 — it was
previously env-var-only, same as web access's history): each client's Settings
page has an "Enable the password vault" switch that writes `vaultEnabled`
through `PUT /settings` (admin-only, persisted via `settingsFile.ts`), same
env > persisted > default precedence as `cardsEnabled`. Setting
`FAMILY_AGENT_VAULT=1`/`0` still pins it (`envLocked.vaultEnabled`, control
goes read-only) for an operator who wants it fixed regardless of what's saved
in the UI. `FAMILY_AGENT_VAULT_AI=0` keeps the vault but denies the assistant
— still env-only, since it's a narrower, less consequential switch than
turning the whole vault on. `/health.vault` (`"on"|"off"`) + `.vaultAi` gate
every client's Vault screen and the `/vault` command. No `dropAllAgents()` on
toggle — `vault-agent` is forced-turn-only and never in any cached agent's
tool list, so there's nothing stale to invalidate.

- `agent-core/src/vault/crypto.ts` — hand-rolled envelope (same call as
  `auth.ts`'s scrypt, `mcp/client.ts`'s JSON-RPC): scrypt KDF, AES-256-GCM for
  entry secrets + key-wrapping, X25519 seal (ECDH + HKDF + AES-GCM) for the
  shared family key. `vault/totp.ts` — RFC 6238 + `otpauth://` parsing, ~1 KB,
  tested against the RFC vectors.
- **Key model.** Per-user random DEK, stored wrapped under (a) a key derived
  from the login password and (b) a one-time recovery code shown at setup. An
  X25519 keypair (private key encrypted under the DEK) opens the sealed family
  key. Private entries encrypted under the DEK, shared entries under the family
  key. Entry `title`/`username`/`url` are **plaintext columns** (so the list +
  search work locked); only the secret blob (password, TOTP seed, notes,
  custom fields) is encrypted. A stolen `family-agent.db` yields no secret.
- **`VaultKeyring`** (`vault/keyring.ts`, process-wide like `ToolSupervisor`)
  holds the DEK + private key in memory per user, only between an unlock and an
  idle timeout (15 min) / explicit lock / sign-out / process exit. `POST
  /auth/login` best-effort auto-unlocks; a restart drops it, so the next vault
  call `423`s and the client calls `POST /vault/unlock`. Admin password reset →
  user unlocks with the recovery code (`POST /vault/recover`, re-wraps + issues
  a fresh code). `VaultService` (`vault/service.ts`) ties store + crypto +
  keyring together — nothing else touches a data key.
- **Shared vault** mirrors the sticky board (`scope='shared'`, any member r/w).
  `POST /vault/family/sync` (admin, own vault unlocked) seals the family key to
  every member using only their stored public keys — no need for each member to
  be present. Setup opportunistically syncs if an admin is unlocked.
- **AI access is forced-turn only, NOT a planner subagent.** `/vault` (aliases
  `/password`, `/2fa`) → `buildFamilyVaultAgent` with three **read-only** tools
  (`search_vault`, `get_password`, `get_totp_code`). Never in the planner's
  `subagents`; refused in a family channel (`runForcedAgentTurn(..., inChannel)`).
  The assistant can't create/edit/delete — that's a human action on the Vault
  screen. Not a routine action agent.
- **Transcript redaction.** A `/vault` turn's live reply keeps the secret; the
  copy written to `chat_messages` (and replayed as history) has every revealed
  value replaced with a placeholder (`redactSecrets` in `server.ts`, fed by an
  `onReveal` collector). **Audit:** the assistant's `get_password`/
  `get_totp_code` + every create/edit/delete write a `vault_access_log` row
  with the entry title, never the value; the Vault screen shows it. The
  screen's once-a-second `GET /vault/entries/:id/totp` poll (`actor: "user"`)
  is deliberately not logged.
- DB: `vault_keys` (base `Store` — family provisioning reads all public keys) /
  `vault_entries` + `vault_access_log` (`ScopedStore`), all new `CREATE TABLE
  IF NOT EXISTS`. Routes: `GET /vault/status`, `POST /vault/{setup,unlock,lock,
  recover}`, `POST /vault/family/sync` (admin), `GET/POST /vault/entries`,
  `GET/PATCH/DELETE /vault/entries/:id`, `GET /vault/entries/:id/totp`, `GET
  /vault/access-log`. Desktop `#view-vault` (`renderVault` in `main.ts`);
  Android `Destination.Vault` / `VaultScreen.kt`. Tests: `test/vault.test.ts`,
  `test/vault.routes.test.ts`. See `docs/DECISIONS.md` → "Password vault".

## Scope notes

Ten subagents ship: `task-agent`, `document-agent`, `builder-agent`,
`notes-agent`, `tools-agent`, `routine-agent`, `research-agent` (web access
on), `workshop-agent` (file processing on), `skill-agent` (skills, default on),
and `connections-agent` (MCP on) — plus `run_code`, a leaf tool
on the planner + `document-agent` (see "Code sandbox" above), and the leaf
`render_card` / `render_artifact` tools (planner + document/research/connections
subagents). The
**`vault-agent`** (`FAMILY_AGENT_VAULT=1`) is forced-turn-only (`/vault`) and
never wired as a planner subagent — see "Password vault" above. `builder-agent`
generates small self-contained web tools (`agent-core/src/tools/*`, and a "Tools" screen in
both apps) — see `docs/STATUS.md` for the architecture. A build starts with a **plan pass**
(`planTool` / `PLAN_SYSTEM`): the model decides `{ needsBackend, operations }` for the ask
(keyword `wantsBackend` is the fallback). Static tools are plain inline HTML served with a
strict CSP from a dedicated port (default 4174); a tool that needs a backend gets a Deno
process in a deny-by-default sandbox (`ToolSupervisor`), with the model only ever writing
`operations.ts` — implementing the planned operation list (`[{ name, description, access,
inputSchema, run }]`; older tools have a `handler.ts` instead, still supported). That backend's harness
(`agent-core/src/tools/harness.ts`, our code) opens one private SQLite database per tool at
`<dataDir>/tools/<id>/data/tool.db` via `node:sqlite` — isolated because `--allow-write` is
scoped to that tool's `data/` dir and ATTACH is disabled; `run(input, ctx)` gets the raw `db`
handle plus a key/value `store` facade (also what `GET/PUT /__state` uses) layered on a `_kv`
table. From the one `operations` array the harness serves an **MCP server** (`POST /mcp`,
JSON-RPC 2.0) that `tools-agent` calls via `agent-core/src/tools/toolMcp.ts`, plain REST
(`/api/<name>`) for the tool's own frontend, and `GET /__manifest`. `FAMILY_AGENT_TOOLS=0`
disables the whole feature.

Tools are **improved in place**, not rebuilt: `iterateTool` (builder.ts) feeds the model its
own prior `operations.ts`/`index.html` + the change; a server improve is generated into
`<toolDir>/.next/`, `ToolSupervisor.smokeTest`'d (boot + `tools/list` + every read op called)
with one self-repair pass, and only swapped over the live files on success — the previous
version goes to `<toolDir>/prev/` for a one-step `revertTool`. `data/tool.db` is never touched
by an improve; schema changes must be additive. `tools` table carries `revision_count` /
`revision_state` / `updated_at`. See `docs/DECISIONS.md` → "Improvable tools".

Still not implemented from the brainstormed architecture: the compute mesh, Tailscale
transport, and the bundled managed-model runtime. Full reasoning for every scope cut is in
`docs/DECISIONS.md`.
