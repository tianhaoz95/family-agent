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
  - *Optional:* `ollama pull nomic-embed-text` enables semantic document search (`config.embedModel`,
    `FAMILY_AGENT_EMBED=0` to turn off). Without it, document search is keyword + trigram-fuzzy only —
    no error, it just falls back. See `docs/DECISIONS.md` → "Follow-up: semantic + fuzzy document search".
- *Optional, for the shell/file-processing capability* (`FAMILY_AGENT_SHELL=1`): `bubblewrap` (the
  sandbox — `apt install bubblewrap`, needs unprivileged user namespaces) plus whichever CLI tools you
  want the agent to use (`ffmpeg`, `qpdf`, `imagemagick`, `poppler-utils`, `jq`, `csvkit`, `pandoc`, …).
  Only installed tools are advertised; missing bwrap = the capability stays off. See
  `docs/DECISIONS.md` → "Web access and shell/file-processing".
- *Optional, for the web capability*: set `FAMILY_AGENT_WEB_SEARCH_PROVIDER` to `searxng`
  (+ `_URL`), `tavily`/`brave` (+ `_API_KEY`), or `ddg` (no setup, best from a home connection).
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
  (`inboxDir`, `model`, `ollamaBaseUrl`, `ocrModel`, `asrModel`, `embedModel`) to `<dataDir>/settings.json` as one
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
    `tools-agent` *uses* one the family already built. It has two generic tools —
    `list_family_tools` / `call_family_tool` — and resolves the catalog live each turn
    from `<toolDir>/mcp.json` caches (a `familyTools.getCatalog` dep), so a new/rebuilt/
    deleted tool needs no graph rebuild. Only wired when `config.toolsEnabled`. See
    `docs/DECISIONS.md` → "Tools as an agent API (MCP)".
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
    `description`, so an image never propagates past the planner turn. It also takes an
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

## "/" forces a chat turn to one specialist agent

The planner's own decision to delegate to a subagent (see `PLANNER_PROMPT`'s
worked examples above) is unreliable on a small model — the same class of
misrouting documented elsewhere in this file. A leading `/` on a 1:1 chat
message skips that decision entirely and routes straight to one specialist,
guaranteed structurally rather than by a stronger prompt:
`parseForcedAgentCommand()` (`agents/index.ts`, next to `mentionsAgent()`)
reads the word right after `/` — `build`→builder, `task`→task, `find`/`search`
(alias)→document, `note`→notes, `schedule`/`remind` (alias)→routine — and
returns `{ kind, text }`; anything else (a tool name, or nothing) still means
`kind: "tools"`, the original behavior, so a plain `/ItemTracker …` message is
unaffected by the recognized keywords existing. Each `kind` has its own
standalone builder — `buildFamilyToolsAgent`/`buildFamilyTaskAgent`/
`buildFamilyDocumentAgent`/`buildFamilyBuilderAgent`/`buildFamilyNotesAgent`/
`buildFamilyRoutineAgent` — a `createDeepAgent` instance with *only* that one
subagent's own tools bound (no `subagents` array, same permissions/middleware
as the planner), so it structurally cannot route anywhere else.
`buildFamilyBuilderAgent` shares `makeBuilderTools()` with the planner's own
builder-agent subagent rather than duplicating those three tool definitions.

`server.ts` keeps one `makeAgentCache()`-built cache per kind (nine total,
including the planner — the five original subagents plus `routine`, `research`,
`workshop`) instead of hand-rolled `Map`s; `dropAgents(userId)`/
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
a small fixed list of the four command keywords (kept in sync by hand with
`FORCED_AGENT_KEYWORDS` — desktop's `SLASH_COMMANDS` in `main.ts`, Android's
`SLASH_COMMANDS` in `ChatScreen.kt`) and the already-fetched tool list
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
`wireSlashMenu(input, menu, chip, form, onChange)` helper — Chat and Messages
call it the same way. A "?" button (next to "+ New" in Chat, in the
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
  `document` | `notes` | `tools`. **`builder` is not a valid value** — a routine
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
default**, each an env-var switch (not a Settings-page toggle — they change the
security posture, like `FAMILY_AGENT_TOOLS`), each reported in `/health`
(`web`, `shell`) so clients show/hide the `/web` and `/run` slash commands.

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

## Scope notes

Eight subagents ship: `task-agent`, `document-agent`, `builder-agent`,
`notes-agent`, `tools-agent`, `routine-agent`, `research-agent` (web access
on), and `workshop-agent` (file processing on) — plus `run_code`, a leaf tool
on the planner + `document-agent` (see "Code sandbox" above). `builder-agent`
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
