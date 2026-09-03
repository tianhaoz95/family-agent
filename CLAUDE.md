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
system: `#f6f5f4` canvas, single `#0075de` blue accent, hairline-border / no-shadow cards, Inter
+ Source Serif 4, **light theme only**). Its tokens live in `desktop/src/style.css` `:root`.

The **Android** app follows its own `android/DESIGN.md` (the "Playful Color Mobile Design
System": `#6366F1` indigo / `#F472B6` pink / `#22D3EE` cyan, soft-shadow rounded cards, Nunito,
**light + dark**). Its tokens live in `android/.../ui/theme/Theme.kt` (`AppAccents`, the two
`ColorScheme`s, typography, shapes) and `android/app/src/main/res/values{,-night}/colors.xml`.
The two design systems are deliberately independent — there is no shared token file, and a
desktop change does **not** imply an Android change (or vice versa).

## Prerequisites

- Ollama running locally with the model pulled: `ollama serve &` then `ollama pull gemma4:e2b`
  (default model; override with `FAMILY_AGENT_MODEL`). The model **must** support tool-calling in
  Ollama's serving layer — that's a property of the specific model, not something deepagents
  provides. Not every model does; confirmed failures and the reasoning are in `docs/DECISIONS.md`.
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
./scripts/start-desktop.sh   # checks Ollama/model, launches the Tauri app
./scripts/start-android.sh   # detects/boots an emulator, builds, installs, launches the app
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
- `settingsFile.ts` — persists the settings the desktop Settings page can change
  (`inboxDir`, `model`, `ollamaBaseUrl`, `ocrModel`, `asrModel`) to `<dataDir>/settings.json` as one
  merged JSON object. Precedence in `config.ts` for each: env var > persisted file > default —
  the env var always wins so an operator's explicit override can't be shadowed by something
  saved from the UI earlier, and when an env var is set that field is `envLocked` (UI shows it
  read-only, `PUT /settings` refuses to change it). Changing `model`/`ollamaBaseUrl` at runtime
  rebuilds the agent + extraction model clients in `server.ts` and, via the `onModelChange`
  callback, restarts the inbox watcher with a fresh client — a langchain `ChatOllama` binds its
  URL and model at construction, so hot-patching isn't possible.
- `agents/index.ts` — the deepagents planner (`buildFamilyAgent`) plus its subagents
  `task-agent`, `document-agent`, `builder-agent`, `notes-agent`, and the
  `askFamilyAgent` / `askFamilyAgentInChannel` / `mentionsAgent` helpers. Notable
  non-obvious things in this file:
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
  **Search** is FTS5 (`documents_fts` / `tasks_fts`), kept in sync by triggers on the base tables
  (same "can't drift" principle, pushed into the DB) with a startup row-count reconcile that
  backfills a legacy DB. `ScopedStore.searchDocuments()` / `searchTasks()` do `bm25()` ranking +
  `snippet()` + structured filters (category / important-date range read straight out of the
  extracted-fields JSON); `toFtsMatchQuery()` turns free text into a safe `MATCH` expression (a
  raw NL string is an FTS syntax error, not a no-op). Empty query = filtered recency list. Full
  rationale (and why not an external search engine) in `docs/DECISIONS.md`.
- `inboxWatcher.ts` — chokidar watch on `config.inboxDir`. Delegates to `fileExtract.ts` for
  whatever's supported there (text, PDF, images); anything else is logged as skipped, not
  silently ignored. Dedupes on `source_path` so restarts don't reprocess files.
- Document ingestion has three entry points into the same pipeline: `POST /documents/ingest`
  (paste text, JSON body), `POST /documents/upload` (multipart file — PDF/photo/scan, the
  `@fastify/multipart`-backed route), and the inbox watcher above. All three end up at
  `store.createDocument()` + `extractDocument()`.
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
machine-settings only when the signed-in user is an admin.

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
`/documents/upload` route the desktop upload UI uses.

## Cross-account: chat + shared board

The first data that isn't per-account. Both added narrowly rather than by loosening
`ScopedStore` (full reasoning in `docs/DECISIONS.md`):

- **Chat** — `channels` / `channel_members` / `messages` tables on the base `Store`
  (not `ScopedStore`). Every read method takes the requesting user id and returns
  nothing when they aren't in `channel_members`. `findOrCreateDm` is idempotent per
  unordered pair; groups have a name. Routes: `GET/POST /channels`, `GET
  /channels/:id`, `GET/POST /channels/:id/messages`, `POST /channels/:id/members`,
  `POST /channels/:id/read`, `GET /family/members` (any authed user, name + username
  only — *not* the admin `/users`). `@agent`/`@ai` in a message (`mentionsAgent()`)
  → `askFamilyAgentInChannel()` runs the mentioner's planner and
  `resolvePendingAgentMessage()` fills in the `_agent_` placeholder row. Clients
  poll. Desktop: `#view-messages` in `main.ts`. Android: `Destination.Messages` +
  nested `conversation/{id}` route, `MessagesScreen.kt`, poll loop in `AppViewModel`.
- **Sticky board** — `sticky_notes` on `ScopedStore`: `scope='private'` is
  `AND user_id = ?`, `scope='shared'` is open to every member (author tracked in
  `user_id`). Routes `GET/POST /notes`, `PATCH/DELETE /notes/:id`. Subagent
  `notes-agent` (`agents/noteTools.ts`: `list_sticky_notes`, `add_sticky_note`).
  Desktop `#view-board`; Android `Destination.Board` / `BoardScreen.kt`.
- **Chat references** — the retrieval tools take an optional `onReference` hook
  (`agents/references.ts`); `server.ts` collects per `/chat` turn and returns
  `references: [{type,id,label}]`. Clients open the item in a side panel (desktop)
  / bottom sheet (Android), also reused by the document Preview button. `GET
  /tasks/:id` and `GET /documents/:id` back it.

## Scope notes

Four subagents ship: `task-agent`, `document-agent`, `builder-agent`, and
`notes-agent`. `builder-agent`
generates small self-contained web tools (`agent-core/src/tools/*`, and a "Tools" screen in
both apps) — see `docs/STATUS.md` for the architecture. Static tools are plain inline HTML
served with a strict CSP from a dedicated port (default 4174); a tool that needs shared state
gets a Deno backend in a deny-by-default sandbox (`ToolSupervisor`), with the model only ever
writing `handler.ts`. `FAMILY_AGENT_TOOLS=0` disables the whole feature.

Still not implemented from the brainstormed architecture: the compute mesh, Tailscale
transport, and the bundled managed-model runtime. Full reasoning for every scope cut is in
`docs/DECISIONS.md`.
