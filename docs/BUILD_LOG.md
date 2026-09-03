# Build log

Chronological, written as the build happened. Timestamps are approximate
(local session time, 2026-08-31 evening PDT). For the *why* behind each
deviation, see `docs/DECISIONS.md` — this file is the *what happened*.

## Environment discovered

- Linux desktop (Ubuntu 24.04), Node 24.14, Rust 1.93 / cargo, no Java, no
  Gradle, no `ANDROID_HOME`. No `cargo tauri` CLI (used the npm
  `@tauri-apps/cli` instead — same tool, prebuilt binary, no compile step).
- `ollama` binary present but no server running; `OLLAMA_HOST` env var
  pointed at a Tailscale IP (`100.99.232.57`) not reachable from this
  session's network namespace. A system-level `ollama serve` (user `ollama`,
  systemd-managed) was already listening on `127.0.0.1:11434` despite that —
  used that instance directly rather than starting a second one.
- No passwordless `sudo`. Docker CLI present but daemon not running (starting
  it needs sudo too). Both system-package installation and containerized
  builds were unavailable — see `docs/DECISIONS.md` for how the Android
  toolchain got installed anyway (user-space tarballs).
- Webkit2gtk-4.1, gtk3, libsoup3 already present as system packages — Tauri's
  Linux build deps were mostly satisfied out of the box. `librsvg2-dev` and
  `libayatana-appindicator3-dev` were not, and could not be installed;
  worked around rather than blocked on (pre-rendered icons, no tray feature).

## agent-core

- Storage: `node:sqlite` (`DatabaseSync`), enabled by default in Node 24
  (`--no-experimental-sqlite` exists as an opt-out flag, confirmed via
  `node --help`) — no native module compile step needed, unlike
  `better-sqlite3`.
- Agent framework: `deepagents` (npm, `deepagentsjs` upstream) — confirmed
  it's the real TypeScript port of LangChain's Deep Agents, not a
  same-named unrelated package, by reading its bundled type definitions
  (`createDeepAgent`, `subagents`, skills support, matching the "skill"
  concept from the architecture notes almost exactly).
- First live-model run against gemma3n:e2b failed outright. That model choice
  was itself a mistake (I misread "gemma 4 e2b" as a model I recognized from
  before my training cutoff rather than the real, newer Gemma 4) — corrected
  in a later pass once the user caught it. See "Correcting the model" below
  and `docs/DECISIONS.md` for the full story.
- After the swap, the first *document extraction* run still failed. Root
  cause found by direct inspection (dumping `result.messages` from a raw
  `agent.invoke()` call, not guessed): the planner's `task` tool call carried
  a mis-transcribed document id (`3f72` → `3f772`). Fixed with short ids +
  bypassing the planner for the ingest extraction step (see
  `docs/DECISIONS.md`).
- Full test run after both fixes: **14/14 passing**, live-model integration
  tests included, ~21–25s total (down from ~157s before the extraction
  fix — the old path burned most of its time on a full planner→subagent
  round trip for a request that didn't need one).
- Added `@fastify/cors` after noticing the desktop UI (a different origin
  from agent-core's perspective) would otherwise be blocked from calling it.
  Verified with a real preflight request via curl and by adding a
  regression test (`answers CORS preflight for the desktop webview origin`).
- Final count: **15/15 tests passing** (13 unit + 2 live-model), `tsc
  --noEmit` clean, `npm run build` clean.
- One false-positive to flag: `npm audit` reported a critical "malware"
  advisory against a package literally named `agent-core` — that's npm's
  advisory DB matching our *local, unpublished* workspace package name
  against an unrelated public package that happened to share the name.
  Renamed the workspace package to `@family-agent/agent-core` to kill the
  false positive rather than leave a scary-looking `npm audit` result for
  reviewers to chase down.

## desktop (Tauri)

- Rust build errors hit and fixed, in order: missing `[lib]` target
  declared but no `src/lib.rs` (removed the unused `[lib]` section — this
  app has no mobile/FFI target), missing `use tauri::Manager;` import for
  `.state()`, a `MutexGuard` lifetime error on window-destroy cleanup (split
  into two statements).
- First real end-to-end smoke test: launched the compiled binary with
  `DISPLAY=:0` (a real X/Wayland session is active on this machine),
  confirmed via its own log output that it spawned `agent-core` and that
  `agent-core` started listening on `127.0.0.1:4173`. Attempted a screenshot
  via `import` (ImageMagick) to visually confirm the UI — failed
  (`Resource temporarily unavailable` reading the root window); no
  `xdotool`/`wmctrl` available either. **UI has not been visually
  confirmed** — process-level and HTTP-level behavior has.
- Killed the running app with `kill -9` to check shutdown behavior and
  found the Node sidecar was orphaned (still listening on 4173 afterward).
  Fixed with `PR_SET_PDEATHSIG` (see `docs/DECISIONS.md`) and re-verified:
  launched again, confirmed the sidecar's PID was live and listening,
  `kill -9`'d the parent, confirmed within ~2s that the port was free and no
  orphaned `node` process remained in `ps aux`.
- Desktop app crashed on launch with `EADDRINUSE 127.0.0.1:4174` — a previous
  `agent-core` had been reparented to `systemd --user` (PR_SET_PDEATHSIG isn't
  airtight across a `tauri:dev` Rust rebuild) and still held ports 4173/4174.
  The tools server's `net.Server` had no `error` listener, so it came out as an
  unhandled 'error' event + stack dump rather than a handled failure. Fix:
  (1) `agent-core` retries `EADDRINUSE` for up to 8s on both ports, then exits 1
  with a one-line `kill $(lsof -ti tcp:…)` hint; (2) permanent `server.on("error")`
  on the tools server past initial bind; (3) `main.rs` `kill_stale_agent_core()`
  reaps stale LISTEN-ers on those ports at startup (cmdline-filtered to ours),
  SIGTERMs the child on shutdown, and also handles `RunEvent::Exit`. Verified:
  ran two `agent-core` instances back to back — second retried then exited
  cleanly with the hint; killed the first and a fresh one bound immediately;
  SIGTERM shuts one down cleanly with ports freed. See `docs/DECISIONS.md`.
- Full manual HTTP smoke test against a freshly built `dist/server.js`
  (after the CORS + short-id fixes): `/health`, CORS preflight on `/tasks`,
  `POST /tasks` (confirmed short id in the response), `POST
  /documents/ingest` → polled `GET /documents` until `extracted` populated
  (landed within ~6s), `POST /chat` with "What tasks do I have open?" (got
  back a correct, specific answer citing the real task and its real id),
  `GET /activity` (showed the full real trail: task.created →
  document.ingested → document.extracted → chat.message → chat.reply).
  All correct on inspection.
- `cargo build` clean, `npm run build` (Vite) clean, `tsc --noEmit` clean.

## android

- No `cargo tauri`-style CLI shortcut here — needed a full Gradle/AGP/Kotlin
  toolchain. Installed JDK 17 (Temurin) and the Android SDK
  (platform-tools, platform 34, build-tools 34.0.0) as user-space downloads
  (~/GitHub/nana/.toolchains/, gitignored) since sudo/Docker were both
  unavailable. Licenses accepted non-interactively (`yes | sdkmanager
  --licenses`).
- Generated a proper Gradle wrapper (`./gradlew`, Gradle 8.9) via a
  one-time bootstrap Gradle install, so the *project* doesn't depend on this
  machine's toolchain paths going forward — only `local.properties`
  (gitignored, machine-specific `sdk.dir`) does.
- Cold build (`./gradlew testDebugUnitTest`): downloaded AGP 8.5.2, Kotlin
  2.0.21, Compose BOM 2024.09.00, and friends from Google/Maven Central
  (network access confirmed working throughout — npm registry, Docker
  registry, dl.google.com, services.gradle.org, Google's Maven repo).
  **Built clean on the first real attempt** — no compile errors, only two
  deprecation warnings (`Icons.Filled.Chat`/`Send` → AutoMirrored variants),
  which were fixed immediately after.
- `./gradlew testDebugUnitTest assembleDebug`: **5/5 unit tests passing**
  (`FamilyAgentApiTest`, against a `MockWebServer` — health parsing, task
  list parsing, request-body verification on task creation, error-message
  content on a 500 response, extraction-field decoding), and a real,
  installable debug APK produced (`app-debug.apk`, ~17.9 MB).
- **Not done**: no Android emulator/AVD installed (another multi-GB
  download, judged lower priority than solidifying the other two apps in
  the time available), so there is no instrumented test coverage and the
  app has never actually run — only compiled and unit-tested. See
  `docs/DECISIONS.md`.

## Polish pass (after the user asked for continued iteration)

- **Correcting the model.** The user pointed out two things: tool-calling is
  not a "deepagents capability," and the requested model was "gemma 4 e2b,"
  not gemma3n. Both correct. Verified gemma4:e2b actually exists (it does —
  released April 2026, after my training cutoff, which is why I didn't
  recognize the name), confirmed it's pulled as `gemma4:e2b` in Ollama's
  library, pulled it (7.2GB), and tested it directly against a raw
  `agent.invoke()` call before trusting it: it correctly called the `task`
  delegation tool with the right subagent and arguments, and the resulting
  task landed in the database with the right title and due date. One
  real cost: ~110s for that single turn on this machine's CPU, vs. a few
  seconds for qwen2.5:3b. Swapped the default, bumped test timeouts
  accordingly (120s → 240s on the two slowest integration tests), reran the
  full suite: 19/19 passing.
- **Folder-watching document ingestion.** Added `chokidar`-based watching of
  `config.inboxDir` (defaults under `dataDir`, so overriding
  `FAMILY_AGENT_DATA_DIR` moves both together). `.txt`/`.md` files get
  ingested automatically; other extensions are logged as skipped, not
  silently dropped. Dedup on `source_path` (new DB column) so restarting the
  watcher doesn't reprocess files already seen. Caught and fixed a real bug
  while testing this: the default `inboxDir` was hardcoded relative to the
  package directory instead of derived from `dataDir`, so a custom data dir
  silently didn't move the inbox with it — fixed before it shipped.
- **Found a real conversational bug via manual testing, not by inspection:**
  asked the running app "What documents do I have?" after ingesting a real
  document, got back "I found no documents in the current location" — wrong.
  Root cause, found by dumping the raw message trace: the planner has
  deepagents' built-in generic filesystem tools (`ls`, `read_file`, etc. —
  unrelated to this app's documents) and called `ls("/")` on its own empty
  scratch space instead of delegating to document-agent. Fixed with a
  combination of denied filesystem permissions, a middleware override that
  removes `ls`/`write_file`/`edit_file` from the planner's tool list
  entirely, and — the part that actually got the planner delegating
  correctly — a worked example in the system prompt, since abstract
  instructions alone didn't change its behavior. Full mechanism in
  DECISIONS.md. Also found and fixed a second problem while chasing this:
  document-agent itself had no `list_documents` tool, so even correct
  delegation would have failed to answer the question. Verified the fix
  with 3 repeated live-model runs (consistent) plus a new regression test.
  Full suite after all three fixes: 25/25 passing.
- **Desktop and Android test coverage gaps closed.** Neither had a
  `tsconfig.json`/test setup before this pass — `desktop/` frontend TS was
  never actually type-checked (Vite's esbuild transpiles without checking).
  Added `desktop/tsconfig.json`, 6 vitest unit tests for `src/api.ts`
  (request formatting, error-message extraction on failure responses),
  wired into the root `npm test`.
- **Android emulator set up** with KVM hardware acceleration — `/dev/kvm`
  wasn't accessible via the user's nominal group membership (`groups` didn't
  list `kvm`), but a direct file-descriptor open succeeded, revealing an
  explicit ACL grant `getfacl` confirmed. This made a real emulator (not
  just compile-and-unit-test) possible without needing sudo to fix group
  membership. System image `system-images;android-34;google_apis;x86_64`
  installed alongside the `emulator` package.

## Visual verification, both platforms

Neither the desktop UI nor the Android app had actually been *seen*
rendering at the point the previous section ended. Closed both gaps:

- **Android**: real emulator with KVM acceleration (see DECISIONS.md for
  how — `/dev/kvm` access existed via an ACL invisible to `groups`), debug
  APK installed and launched, all 5 screens captured via
  `adb shell screencap` (reads the emulator's own framebuffer, not the
  host display — sidesteps the host's screenshot restriction entirely).
  Found and fixed 3 real UI bugs this way: an off-palette lavender
  bottom-nav color (Material3's default tonal surface, not the app's
  ledger tokens), a due-date field too narrow for its own placeholder text,
  and stale "folder watching is future work" copy that had been true when
  written and false by the time anyone looked at the screen again.
  Confirmed genuine cross-device connectivity — pointed the emulator at
  the host's agent-core via `10.0.2.2` and got a real "Connected · local ·
  gemma4:e2b" in the Settings screen.
- **Desktop**: the host's X11/Wayland session refused every screenshot
  tool tried (ImageMagick, PIL, GNOME's screenshot D-Bus API — all failed
  identically, confirming a sandbox restriction rather than a tool
  problem). Solved by serving `desktop/dist/` and driving headless
  Chromium via Playwright — since the Tauri window is just this same
  HTML/CSS/JS in a webview, rendering it in any browser shows the same
  content. Captured Chat (including a full live round trip — typed a
  message, watched the "thinking…" state, got gemma4:e2b's real reply,
  which correctly excluded an already-completed task), Tasks, Documents
  (with the live-loaded inbox path), and Activity, all against real seeded
  data and a fresh network request each time. Screenshots sent to the
  user directly during the session.
- **Found and fixed a real conversational bug in the process**: "Add a
  task to buy stamps" got refused ("I cannot perform real-world actions
  like buying stamps") because the planner's delegation description
  dropped the "create a task" framing. Fixed on the task-agent side
  (never refuse, a bare phrase always means "track this as a task") for
  defense in depth — full detail in DECISIONS.md. Verified consistent
  across repeated runs plus a new permanent regression test.

## Final state

- 30/30 agent-core tests passing (live-model tests against gemma4:e2b),
  including regression tests for both bugs found via the Android/desktop
  verification pass above.
- 6/6 desktop frontend tests passing; Rust build clean, frontend build
  clean. Full HTTP-level, folder-watching, and now visual/interactive
  flows all verified against the live model.
- 5/5 Android unit tests passing, real APK produced, now verified running
  on an actual emulator with correct rendering and real backend
  connectivity.
- iOS: not attempted, per explicit instruction.
- Nothing left open from the original "what's actually been seen working"
  gap — both apps have been watched doing the real thing, not just
  compiled and unit-tested.

## Voice input (speech-to-text)

Added a mic button to both chat composers. Recording → `POST /transcribe`
(multipart, field `audio`, a 16 kHz mono WAV) → transcript dropped into the
input for review. Never auto-sent.

- **agent-core**: `src/transcribe.ts` — Whisper via `@huggingface/transformers`
  (v3, `onnxruntime-node`), lazy-loaded, model cached under
  `<dataDir>/asr-models/`. A dependency-free WAV parser (`decodeWav`) +
  linear-interp resample to 16 kHz, so the route never touches an audio codec.
  New route `POST /transcribe` in `server.ts` (403 when `FAMILY_AGENT_ASR=0`,
  400 on a non-multipart / empty body); `/health` and `/settings` gained
  `asrEnabled`; `asrModel` is an admin machine setting
  (`Xenova/whisper-base` default, `FAMILY_AGENT_ASR_MODEL` env-locks it).
- **desktop**: `src/audio.ts` captures mic PCM via the Web Audio API
  (`getUserMedia` -> `MediaStreamSource` -> `ScriptProcessorNode`), merges the
  Float32 chunks, linear-resamples to 16 kHz and writes a PCM16 WAV. **Not
  `MediaRecorder`** — it isn't implemented in the Linux WebKitGTK webview
  ("MediaRecorder is unsupported on this platform"), found on the first
  desktop test; the Web Audio path works there and needs no codec. `main.ts`
  wires the mic button (tap to start, tap to stop, pulsing red while
  recording) and a "Voice input" Settings section.
- **android**: `ui/VoiceRecorder.kt` uses `AudioRecord`
  (`VOICE_RECOGNITION`, 16 kHz mono PCM16) and prepends a WAV header;
  `RECORD_AUDIO` is runtime-requested on first tap. `ChatScreen` gets a mic
  `IconButton` (Stop icon + error tint while recording, a spinner while the
  clip uploads); `AppViewModel.transcribeVoice` posts it and fills the
  composer.

**Verified**

- `transcribe.test.ts`: WAV decode (mono/stereo/LIST-chunk/non-WAV), resample,
  the "clip too short → empty" guard; an opt-in (`FAMILY_AGENT_TEST_ASR=1`)
  live test that loads the real model.
- Full agent-core suite: 107 passed, 1 skipped (the opt-in one), live-model
  integration tests included.
- End-to-end against the running server: `curl -F audio=@jfk.wav
  /transcribe` → `"And so my fellow Americans ask not what your country can do
  for you…"` in ~2.4s on CPU; non-multipart request → 400; activity log gets a
  `voice.transcribed` row.
- Desktop: signed in via the browser build, confirmed the mic button renders
  next to the attach button and the "Voice input" settings section shows with
  the model pre-filled.
- desktop `npm test` 20/20, `npm run typecheck` clean; android
  `testDebugUnitTest` (24) + `assembleDebug` clean.

**Linux WebKitGTK mic permission — fixed after first report.** On Linux the
webview gave an immediate `getUserMedia` rejection ("not allowed by the user
agent…") because WebKitGTK has no interactive permission prompt — its default
`permission-request` handler just denies media capture. Fixed with
`grant_webview_media_permission()` in `desktop/src-tauri/src/main.rs`: in
`.setup()`, reach the underlying `webkit2gtk::WebView` via
`window.with_webview(...)` and connect a `permission-request` handler that
`.allow()`s the request. `webkit2gtk = "=2.0.2"` added as a
`cfg(target_os = "linux")` dependency — pinned to the exact version `wry
0.55.1` already resolves, so it's the same compiled crate, no new download.
Auto-approving is fine here: the webview only ever loads our own bundled
`dist/` and localhost, and the user has to click the mic button to trigger a
request. macOS/Windows and the `npm run dev` browser build never needed this.

## Document & task search (FTS5)

Replaced the "list every row and let the model skim it" approach with real
keyword search. Full rationale (and why not Meilisearch/Typesense/OpenViking)
in DECISIONS.md → "Document & task search". Blow-by-blow:

- Probed `node:sqlite` first: FTS5, JSON1 (`json_extract`/`json_each`), and
  triggers all work in the bundled SQLite (Node 24) with no extension. A raw
  natural-language string passed to `MATCH` is a *syntax error*
  (`fts5: syntax error near "'"`), not a no-op — so queries have to be
  tokenised.
- **agent-core**:
  - `db.ts` — `documents_fts` / `tasks_fts` standalone FTS5 tables +
    `AFTER INSERT/UPDATE/DELETE` triggers, created in `migrate()` (not
    `SCHEMA`, because the triggers reference `user_id`, which a legacy
    single-user DB only gets in the column migrations). Row-count
    reconciliation on startup backfills/self-heals the mirror.
    `toFtsMatchQuery()` reduces free text to quoted prefix tokens
    (`"car"* "insurance"*`), drops 1-char noise, caps at 12 tokens, returns
    `""` when nothing's searchable. `ScopedStore.searchDocuments()` /
    `searchTasks()` — `bm25()` ranking + `snippet()`, JSON-based
    `category`/date filters, empty-query fallback to a filtered recency list.
    `Store.rebuildSearchIndex()` for ops.
  - `agents/documentTools.ts` / `taskTools.ts` — `search_documents` /
    `search_tasks` tools. `agents/index.ts` — document-agent, task-agent, and
    planner prompts rewritten to prefer search over list; subagent
    `description`s updated.
  - `server.ts` — `GET /documents/search`, `GET /tasks/search`.
- **desktop** / **android** — `searchDocuments` / `searchTasks` client
  methods + response types only. No UI (see DECISIONS.md).
- Fixed one flaky test: the empty-query fallback ordered only by
  `created_at DESC`, and two rows created in the same millisecond tie —
  added `, rowid DESC` as a deterministic tiebreak.

**Verified**

- agent-core: `db.test.ts` (+18: FTS matching on filename/body/summary,
  ranking, per-user scoping, category + date-range filters, index freshness
  across extraction/delete, legacy-DB backfill, `rebuildSearchIndex`,
  `toFtsMatchQuery` unit tests), `documentTools.test.ts` (+3),
  new `taskTools.test.ts` (5), `server.routes.test.ts` (+3). Fast suite green;
  full suite (with live-model integration tests) left running.
- desktop: `npm test` 21/21, `npm run typecheck` clean.
- android: `testDebugUnitTest` 17/17, `compileDebugKotlin` clean.

### Follow-up: three fixes after a live test of "what is my insurance number?"

The user uploaded an insurance EOB and asked "what is my insurance number?"
against a **stale build** (the desktop had spawned `dist/server.js` from before
the search feature — `documents_fts` didn't even exist yet). Rebuilt and
retested against the live model; the planner *did* delegate, but document-agent
came back empty. Root cause and fixes:

1. **Query tokens were ANDed.** `"insurance" AND "number"` — the document has
   "insurance" but never the literal "number", so zero results. Changed
   `toFtsMatchQuery` to join tokens with `OR` and let `bm25()` rank. Verified:
   the same question now answers *"Your insurance Member ID … is 210284396,
   from insurance.pdf."*
2. **Category wasn't searchable.** Added a `category` column to `documents_fts`
   (fed from the extracted JSON by the triggers) so "insurance" / "bill" match
   a document classified that way even if the OCR text doesn't contain the
   word. FTS mirror schema is now migrated by a `dropFtsTableIfColumnsDiffer`
   guard + trigger drop/recreate on every start.
3. **Searches were invisible in the audit trail.** `search_documents` /
   `search_tasks` now log a `document.searched` / `task.searched` activity row
   from the tool wrapper (HTTP `/…/search` stays silent).

Tests: +2 regression tests in `db.test.ts` (multi-word query where only one
word is in the doc; category-only match), `toFtsMatchQuery` tests updated for
OR. Fast suite 130 pass / 1 skip; `dist/` rebuilt.

**The user still needs to restart agent-core** (or the desktop app) to pick up
any of this — their running process is the pre-search build.

## Markdown rendering in chat (both clients)

The planner model replies in Markdown (bullet lists, `**bold**`, code, the
occasional table); both chat views were rendering it as plain text, so a list
came out as `- foo\n- bar` on one line-wrapped blob.

- **desktop:** `marked` + `dompurify` (bundled, no CDN — matches the local-first
  rule). `appendBubble()` renders the **assistant** role only through
  `renderMarkdown()` (sanitised HTML) and tags the bubble `.bubble-markdown`;
  user/system bubbles stay `textContent`. `.bubble-markdown` drops the
  plain-text `white-space: pre-wrap` and styles the block elements to
  DESIGN.md tokens. A delegated click handler on `#chat-log` routes any
  rendered `<a>` through `window.open(_, "_blank")` so a link can't navigate
  the Tauri webview off the app.
- **android:** `com.mikepenz:multiplatform-markdown-renderer-m3` (pure Compose,
  themes off `MaterialTheme`). `ChatBubble` renders the assistant side with
  `Markdown(...)`, user side stays `Text`.
- Tests: desktop 21 pass, `assembleDebug` + `testDebugUnitTest` clean. `dist/`
  rebuilt — the user must restart agent-core/desktop to pick it up.

## Desktop chat controls + a nicer Family tab

Three desktop-only UX fixes, no agent-core changes:

- **New chat / Stop.** The chat header gained a "New chat" ghost button
  (`startNewChat()` — clears the transcript, restores the empty state, drops
  staged images, aborts anything in flight). While a reply is pending the Send
  button swaps to a danger-tinted **Stop** that calls `chatAbort.abort()`;
  `api.chat()` now takes an optional `AbortSignal` and the submit handler
  turns an `AbortError` into a quiet "Stopped." system bubble. Note: abort is
  client-side only — the planner turn keeps running on the server and its
  reply is discarded (threading an `AbortSignal` through the deepagents
  `invoke` is a much larger change; the chat is stateless server-side so
  "New chat" is purely the visible thread).
- **Enter to send.** `keydown` on the textarea: plain Enter calls
  `chatForm.requestSubmit()`, Shift+Enter (and `isComposing`, for IMEs)
  inserts a newline. Added `autoGrowChatInput()` so the composer grows with
  its content up to the CSS max-height.
- **Family tab.** Restructured `#view-family`: the add-account form is now a
  card with a 2-col labelled `.field-grid` and a footer row (status + submit);
  the members list gets deterministic initial-avatars (tint hashed from the
  username, DESIGN.md accent cast), a "You" pill on the current user, an
  admin/member role badge, monospace `@handle`, and hover-revealed
  text-button actions (Reset password / Remove) instead of a stray ghost
  button + X icon. `#view-family` scrolls like `#view-settings`.
- Tests: `typecheck` clean, desktop 21 pass, `vite build` clean. `dist/`
  not rebuilt here (Tauri `tauri:dev` builds the frontend itself); restart
  the desktop app to pick it up.

## "What is my insurance number?" refused again — model-behaviour fix

The user re-hit the old symptom: uploaded `~/Downloads/insurance.pdf`, asked
"what is my insurance number?", got *"I cannot provide personal information
such as insurance numbers. Please check your family documents for this
information."*

Not the FTS regression from earlier (that was ANDed query tokens; the search
still returns the right doc — `db.test.ts` covers this phrasing verbatim).
This is a small-model safety reflex: the planner answers directly with a
privacy refusal instead of delegating to document-agent. Same family as the
"buy stamps" refusal.

Fixed in three layers (full write-up in `docs/DECISIONS.md`):

- `PLANNER_PROMPT`: the family's own paperwork is not PII to withhold from
  them; "detail out of a document" questions go to document-agent; refusing is
  never acceptable. Worked example for this exact phrasing.
- `DOCUMENT_AGENT_PROMPT`: for a specific-value question, search →
  `get_document` → quote the value; don't refuse once the doc is found.
- `askFamilyAgent`: narrow `LOOKS_LIKE_REFUSAL` regex triggers the existing
  one retry and is kept as the fallback (never downgraded to the generic
  error).

Tests: `askFamilyAgent.test.ts` +3 (fast), `agents.integration.test.ts` +1
(live model). Fast suite green, typecheck clean. **`dist/` rebuilt** — the
user must restart agent-core / the desktop app to pick this up.

## Document originals now keep their real filename on disk

The user opened `~/.local/share/family-agent/documents/ACMAHBEK/` and found
extensionless blobs (`7D547MX2`, `KHNB5CCF`) — the bytes were intact (a PNG and
a PDF, verified with `file`), but every stored upload was named after its doc
id, so the folder wasn't browsable.

Changed so an uploaded original is saved under the document's own filename:

- New `agent-core/src/documentFiles.ts` — `sanitizeDiskName()` (one safe path
  segment, extension kept, length-capped), `uniqueInDir()` (`" (2)"`, `" (3)"`
  … suffix on collision), `storeOriginalUpload()`, `renameOriginal()`,
  `deleteOriginal()`, `resolveOriginalPath()` (tracked name → legacy `<docId>`
  → watched-folder `source_path`), and `backfillOriginalDiskNames()`.
- `documents.original_disk_name` column (nullable; migration added). null =
  no stored original, or a legacy `<docId>`-named file not yet migrated.
- `server.ts`: `POST /documents/upload` writes under the filename and records
  the disk name; `PATCH /documents/:id` moves the file to track a rename
  (collision-suffixed, never clobbers another doc); `DELETE` removes both the
  tracked name and the legacy path; `GET /documents/:id/original` resolves via
  `resolveOriginalPath()`. `main()` runs `backfillOriginalDiskNames()` once at
  startup to rename pre-existing `<docId>` files.
- Clients unchanged — they only ever hit `GET /documents/:id/original`. The
  extra `originalDiskName` field on the document JSON is ignored (desktop is
  structural, Android is `ignoreUnknownKeys = true`).

Tests: `server.routes.test.ts` +5 (real-filename storage, rename-moves-file,
upload collision, rename collision, legacy `<docId>` + backfill). Fast suite
green (184 pass / 1 skip), typecheck + `npm run build` clean. **`dist/`
rebuilt** — restart agent-core / the desktop app to pick this up. Existing
extensionless files are renamed automatically on the next start.
