# Status — start here

Built autonomously in one unsupervised session per instruction ("act
autonomously, don't ask me anything, I'll be back in 6 hours"). This is the
entry point for reviewing it — human or AI. Read `docs/DECISIONS.md` next for
every judgment call made along the way — most importantly the model story,
which took two passes: I initially misread "gemma 4 e2b" as a model I
recognized from before my January 2026 knowledge cutoff (gemma3n:e2b) rather
than the real, newer Gemma 4 (released April 2026, after my cutoff), tested
against the wrong model, and drew the wrong conclusion from that. Corrected
after the user pushed back: the actual default is now `gemma4:e2b`, verified
by hand to support tool-calling correctly. Full story, not glossed over, in
DECISIONS.md. `docs/BUILD_LOG.md` has the blow-by-blow of everything else
that broke and how it was fixed.

## What's here

```
agent-core/   Node/TS backend — local HTTP API, SQLite storage (FTS5 keyword +
              trigram-fuzzy + Ollama-embedding semantic search over documents,
              FTS5 keyword search over tasks), the deepagents planner +
              task-agent/document-agent subagents, Ollama client.
desktop/      Tauri v2 app. Spawns agent-core as a local sidecar process.
              Chat / Tasks / Documents / Activity UI.
android/      Kotlin + Jetpack Compose companion app. Same four screens plus
              Settings (server URL). Talks to agent-core over plain HTTP.
ios/          Native SwiftUI companion app — full feature parity with android/,
              Apple Liquid Glass on iOS 26 with an iOS 18 material fallback.
              Hand-authored xcodeproj (synchronized groups). Talks to agent-core
              over plain HTTP. See "Native iOS app" below and ios/README.md.
docs/         This file, DECISIONS.md, BUILD_LOG.md.
.toolchains/  Downloaded JDK/Android SDK/Gradle (gitignored, machine-local —
              see "Reproducing the toolchain" below if this matters to you).
```

## What actually works, verified by hand — including visually, on both platforms

- **agent-core**: 30/30 tests pass (mix of unit tests and live-model
  integration tests against the real local model). Full HTTP flow
  smoke-tested manually: create a task via `/chat` in natural language,
  drop a `.txt` file in the watched inbox folder and watch it get
  classified with a category/summary/dates within seconds, ask "what
  documents do I have?" and get a correct answer citing the real file,
  list activity and see the real audit trail. `gemma4:e2b` via Ollama,
  running locally, nothing leaves the machine. It's slow — a full planner
  turn can take up to ~110s on this machine's CPU — see DECISIONS.md.
- **desktop**: builds clean, launches, spawns agent-core correctly, survives
  a hard-kill of the parent process without orphaning the Node sidecar.
  UI visually confirmed via headless Chromium (same HTML/CSS/JS the Tauri
  webview renders — host-level screenshot tools were sandbox-blocked, see
  DECISIONS.md for how this was worked around): a full live chat round
  trip, Tasks, Documents, and Activity all screenshotted against real data
  and a live backend, sent to the user during the session. Native window
  chrome itself (title bar, OS resize handles) still hasn't been seen —
  everything inside the window has.
- **android**: builds clean, 5/5 unit tests pass, real APK, **now verified
  running on an actual emulator** (KVM-accelerated) — installed, launched,
  all 5 screens screenshotted via `adb shell screencap`, connected to a
  real agent-core instance over the network and got a live "Connected ·
  local · gemma4:e2b." Found and fixed 3 real UI bugs this way (an
  off-palette nav-bar color, a too-narrow date field, stale copy) — detail
  in DECISIONS.md. To try it yourself: sideload
  `android/app/build/outputs/apk/debug/app-debug.apk` onto a real device
  (or set up your own AVD) and, in Settings, point it at your desktop's
  LAN IP and port 4173.
- **A real conversational bug was found and fixed along the way**: "Add a
  task to buy stamps" got refused by the agent before a prompt fix — see
  DECISIONS.md. Caught by actually using the app through its UI, not by
  reading code.

## What's deliberately not built

The brainstorm doc (the architecture-notes artifact from earlier in this
conversation) describes considerably more than this: a compute mesh of
worker-node laptops/phones, Tailscale/relay transport, a bundled/managed
local-model runtime, a sandboxed scratch-tool builder agent, and four domain
subagents instead of two. None of that is here. This build is the core
vertical slice — chat, tasks, documents, activity, running fully locally —
because that's what was achievable and *verifiable* unsupervised in one
session, and because standing up a code-execution sandbox with no one
available to review its boundary before it runs isn't something to do
unattended. Full reasoning for every cut is in `docs/DECISIONS.md`.

## Running it yourself

**Easiest path** — two scripts, run from the repo root, each does its own
readiness checks and prints a clear error instead of failing halfway
through:

```bash
./scripts/start-desktop.sh   # checks Ollama/model, then launches the Tauri app
./scripts/start-android.sh   # detects a running emulator or boots+creates one,
                              # then builds, installs, and launches the app on it
```

`start-android.sh` leaves the emulator running afterward — safe to re-run,
it reuses whatever's already up rather than starting a second one.

**Manual path**, if you'd rather run each piece yourself:

```bash
# 1. Ollama must be running locally with gemma4:e2b pulled
ollama serve &
ollama pull gemma4:e2b

# 2. agent-core (build once, or `npm run dev` for live reload)
cd agent-core && npm install && npm run build

# 3. Desktop app (spawns agent-core itself — no need to start it separately)
cd desktop && npm install
export JAVA_HOME=  # not needed here, just Node + cargo
npm run tauri:dev      # dev mode, or:
npm run tauri:build    # produces a .deb/.AppImage in src-tauri/target/release/bundle

# 4. Android (needs the toolchain — see below if .toolchains/ isn't present)
cd android
export JAVA_HOME=$(pwd)/../.toolchains/jdk17
export ANDROID_HOME=$(pwd)/../.toolchains/android-sdk
./gradlew testDebugUnitTest assembleDebug
# APK at app/build/outputs/apk/debug/app-debug.apk
```

Tests:

```bash
npm test    # from repo root: runs agent-core (128 fast tests + live-model integration tests; ~10s without Ollama — live tests self-skip) then desktop (21 tests)
cd android && ./gradlew testDebugUnitTest   # 17 tests, no device needed
```

## Recovering a locked-out admin

There is no password-reset flow — the app is fully local (no email/SMS) and
`POST /auth/bootstrap` refuses to run once any account exists. Recovery is
manual, against the SQLite store (default
`~/.local/share/family-agent/family-agent.db`, or `FAMILY_AGENT_DATA_DIR`, or
the legacy in-repo `agent-core/data/`):

- **Forgot the username:** `./scripts/show-accounts.sh` prints every account's
  username, display name, and role (admins first). Passwords are scrypt hashes
  and are never printed.
- **Forgot the password:** with a *second* admin, reset it from the desktop
  **Family** screen. Otherwise, stop the app and run:
  ```bash
  ./scripts/reset-password.sh <username>              # sets + prints a random password
  ./scripts/reset-password.sh <username> <password>   # or set a specific one (>= 6 chars)
  ```
  It writes a fresh hash via agent-core's own `hashPassword()` (no build/tsx
  needed — Node strips the TS types) and signs out that account's other
  sessions.
- **Last resort** (single-household, merges everyone's data into one new
  admin): `UPDATE tasks/documents/activity/tools SET user_id='_legacy_';
  DELETE FROM users; DELETE FROM sessions;` then re-run first-time setup —
  `bootstrap` reassigns the `_legacy_` rows to the new admin.

A proper `agent-core` reset command is a worthwhile follow-up.

**Password vault + a reset:** `reset-password.sh` (or a second admin's reset)
severs the vault's login key — that user's `vault_keys` row is still encrypted
under the *old* password. They sign in with the new password, then on the Vault
screen enter their **recovery code** (shown once at vault setup); that re-wraps
the vault under the new password and issues a fresh code. Without the recovery
code the vault contents are unrecoverable by design. See `docs/DECISIONS.md` →
"Password vault".

## Password vault

`FAMILY_AGENT_VAULT=1` turns on a per-user encrypted store for passwords + TOTP
seeds, with an optional shared family vault, that the local assistant can read
out via `/vault` in a private chat ("what's my Netflix password", "the 2FA code
for the bank"). `FAMILY_AGENT_VAULT_AI=0` keeps the vault but denies the
assistant. Off by default — it changes the security posture, so it's an env
switch, not a Settings toggle. Crypto is `node:crypto` only (scrypt + AES-GCM +
X25519), hand-rolled in `agent-core/src/vault/`. A stolen `family-agent.db`
yields entry titles/usernames but no secret. First use: open the **Vault**
screen (desktop or Android), confirm your account password, save the one-time
recovery code. Full design + every non-obvious call: `docs/DECISIONS.md` →
"Password vault"; contract summary in `CLAUDE.md` → "Password vault".

## Visual cards in chat

The assistant can answer with a small generated **chart / checklist / diagram**
— an HTML+JS snippet it writes, embedded inline in the chat and family channels.
**On by default; toggle it off** in the desktop or Android Settings ("Visual
cards in chat") for a strictly text-only, more predictable experience
(generated code is less stable than text). `FAMILY_AGENT_CARDS=0` on the server
forces it off. Each card runs in a sealed sandbox — opaque-origin iframe /
`null`-base WebView, a `default-src 'none'` no-network CSP — so it can't reach
the app, your data, or the network. Full design: `docs/DECISIONS.md` →
"AI-generated HTML cards"; contract in `CLAUDE.md` → "Generated HTML cards".

## Desktop opens to a blank window

If a previous run left an orphaned `node dist/server.js` holding port 4174 (the
tools server), the newly spawned `agent-core` used to `exit(1)` and the app sat
blank forever. Now: `agent-core` keeps serving the API without Tools, and after
~12s the window shows a "Can't reach the local service" card with **Try again**
instead of staying blank. To clear it manually: `kill $(lsof -ti tcp:4173
tcp:4174)` then relaunch. Full write-up in `docs/DECISIONS.md` → "Blank desktop
window when the tools port was busy".

## Reproducing the toolchain

`.toolchains/` (JDK 17, Android SDK, a bootstrap Gradle) is gitignored and
specific to this machine. It was assembled without sudo or Docker (neither
was available — see DECISIONS.md), by hand, in the background while other
work continued. The commands are in `docs/BUILD_LOG.md`'s "android" section;
nothing about them is machine-specific except the install path, but they
were never turned into a script. Worth doing if this needs to run on a
second machine.

## Suggested next steps, roughly in order

1. Decide whether `gemma4:e2b`'s latency (~110s/turn on this machine's CPU)
   is acceptable for real use, or whether a faster model is worth trading
   away "uses exactly the requested model" for. Both are one env var
   (`FAMILY_AGENT_MODEL`) apart — no code change needed either way.
2. Actually run the Android app on a real phone at least once — it's been
   verified on an emulator, but a real device (real touch input, real
   network conditions) is still a step removed from that.
3. Pick up the deferred pieces in whatever order matters most: **content
   sharing between family accounts** (the natural follow-on now that
   multi-user auth + isolation is in — see the multi-user entry under "Later
   changes"), Tailscale transport, the compute mesh.

Later changes (not part of the original autonomous session):
- **Android UI: full visual redesign to `android/DESIGN.md`** (the "Playful
  Color Mobile Design System" — indigo/pink/cyan, soft-shadow rounded cards,
  Nunito, **light + dark**). The Android app no longer shares the repo-root
  `DESIGN.md`; the desktop app still does. Bundled Nunito
  (`res/font/nunito_variable.ttf`). Dark mode is driven by
  `isSystemInDarkTheme()` with a day/night `windowBackground` colour so
  there's no launch flash (non-DayNight style parent — `Theme.Material.DayNight`
  needs API 29, minSdk is 26). Rounded icon set throughout. Verified on the
  emulator in both light and dark.
- **Android nav redesign**: the bottom `NavigationBar` is replaced by a
  `ModalNavigationDrawer` — Chat is the app's main surface (start
  destination, full-height), and a collapsible left sidebar (a filled menu
  button in the top bar) switches between Chat / Tasks / Documents / Tools /
  Activity / Settings. Gradient brand mark, a filled-indigo pill behind the
  active nav item, and a connection-status pill pinned to the drawer footer
  (refreshed each time the drawer opens). The in-app tool WebView route keeps
  its own full-bleed chrome — the top bar and drawer gestures are suppressed
  there. All in `android/.../MainActivity.kt`; the per-screen `ScreenScaffold`
  headers are unchanged in structure (restyled by the new theme).
- UI of the desktop and Android apps follows **`./DESIGN.md`** ("Notion — warm
  paper notebook"): warm `#f6f5f4` canvas, white hairline-bordered cards (no
  shadows), a single blue accent (`#0075de`), Inter + Source Serif 4 (bundled
  locally, no CDN), 12px card / 8px button / pill radii. **Light only** — dark
  mode is deliberately not implemented. Tokens live in `desktop/src/style.css`
  `:root` and `android/.../ui/theme/Theme.kt`, kept 1:1.
- Desktop Settings are now fully live-editable: chat **model** (dropdown
  populated from `GET /ollama/models`), **Ollama address** (text), **watched
  folder** (text + a native directory picker via `tauri-plugin-dialog`, shown
  only when running as the Tauri app), and **OCR engine** (dropdown). Changing
  model / Ollama URL rebuilds the in-process agent + extraction clients and
  restarts the inbox watcher — no app restart. Any setting pinned by its env
  var (`FAMILY_AGENT_MODEL`, `OLLAMA_BASE_URL`, …) stays read-only in the UI
  and `PUT /settings` refuses to change it (`envLocked` in the payload).
- Extraction poll in the desktop Documents view now runs until nothing is
  `pending` instead of a fixed 18s, so the "Extracting…" spinner no longer
  sticks until a tab switch.
- **Multimodal chat**: both apps can attach images to a chat message (desktop:
  attach button, paste, drag-drop; Android: photo library or camera). Images
  are downscaled to ≤1536px and JPEG-encoded client-side, sent to `POST /chat`
  as `images: [data-uri]` (max 4), and passed straight to the planner model
  (gemma4:e2b is multimodal) as a `HumanMessage` content array. Subagents only
  ever get text, so an image never leaves the planner step. `/chat` body limit
  raised to 24 MB. Verified end-to-end: a photo of text → model transcribes it.
- Dropped `android.permission.CAMERA` from the manifest — camera capture goes
  through the system camera app (`TakePicture`), which needs no app-side
  permission; declaring it would have *required* a runtime grant. Fixes a
  latent issue in the Documents "Scan" button too.
- **Voice input (speech-to-text)**: a mic button in both chat composers records
  a clip and posts it to `POST /transcribe`; the transcript lands in the input
  box for the user to review and send (never auto-sent). Whisper runs
  **in-process in agent-core** via transformers.js / onnxruntime-node
  (`agent-core/src/transcribe.ts`) — Ollama can't serve ASR, so this is a
  separate local inference path, the same shape as OCR. Model
  (`Xenova/whisper-base` by default, admin-settable, `FAMILY_AGENT_ASR_MODEL` /
  `FAMILY_AGENT_ASR=0`) is pulled from the HF CDN once and cached under
  `<dataDir>/asr-models/` — the one deliberate "leaves the machine" event, like
  tesseract's language data. Clients send a 16 kHz mono WAV (desktop decodes via
  WebAudio, Android records raw PCM with `AudioRecord`) so the server side is a
  header parse with no codec dependency. Verified end-to-end against the real
  server: an 11s speech clip transcribed accurately in ~2.4s on CPU. Whisper's
  planner path is untouched — a transcript is a mechanical step (cf.
  `extraction.ts`). Linux needs a `permission-request` handler in the Rust
  shell for the webview to allow `getUserMedia` (WebKitGTK has no interactive
  prompt and denies by default) — `grant_webview_media_permission()` in
  `desktop/src-tauri/src/main.rs`, added after the first test report; see
  BUILD_LOG. Android uses a native runtime grant (`RECORD_AUDIO`).
- **Voice output (text-to-speech)**: a "Read aloud" button on every assistant /
  agent reply (desktop + Android) synthesises the reply and plays it; an opt-in
  "read replies aloud automatically" toggle in both clients' Settings does it on
  every new Chat reply. **Kokoro-82M** (`onnx-community/Kokoro-82M-v1.0-ONNX`, q8
  ~86 MB) runs **in-process in agent-core** via `kokoro-js` / onnxruntime-node
  (`agent-core/src/tts.ts`) — same shape as ASR/OCR, Ollama can't serve TTS. The
  phonemizer is a WASM espeak-ng (no native binary). Model cached under
  `<dataDir>/tts-models/`; first call ~15–20s, then ~2–5s/reply on CPU. `POST
  /speak` (markdown stripped to plain text, ≤2000 chars, returns 16-bit PCM WAV
  for Android `MediaPlayer` compatibility) + `GET /tts/voices` (28 voices;
  default `af_heart`, admin-settable `FAMILY_AGENT_TTS_VOICE`, applied per-call).
  Auto-read is client-local (desktop `localStorage`, Android DataStore), off by
  default, private Chat only. `FAMILY_AGENT_TTS=0` disables it (routes 403,
  `/health.ttsEnabled` false, clients hide the button + toggle). Verified
  end-to-end on both clients.
- **Push-to-talk voice mode**: the mic button in Chat *and* the family-channel
  composer (both clients) gains a **press-and-hold** gesture alongside the
  existing quick-tap dictation. Holding shows a full-screen "listening" overlay
  with a live mic-driven waveform; releasing transcribes **and sends** in one
  motion, then **speaks the reply back** (voice in → voice out, overriding the
  auto-read setting for that turn only). Sliding off the button before releasing
  cancels (overlay turns red, "Release to cancel"; Esc also cancels on desktop).
  Desktop: raw Pointer Events in `wireMic` (`main.ts`), `#voice-overlay`,
  `startRecording(onLevel)` in `audio.ts`. Android: `HoldToTalkMic` +
  `VoiceOverlay` (`ui/VoiceOverlay.kt`, Compose `awaitEachGesture`, rendered
  inline not in a `Popup` so it can't cancel the in-flight gesture),
  `VoiceRecorder.amplitude`, `AppViewModel.sendChatVoice` / `sendChannelVoice`.
  Also adds a mic button to the Android Conversation screen, which had none.
  Verified: desktop end-to-end (mocked audio — overlay, slide-cancel, quick-tap,
  auto-send, auto-speak); Android on the emulator (overlay, slide-to-cancel,
  permission flow, graceful empty-speech handling).
- **Builder tools shipped** (the §03 "sandboxed scratch-tool builder" that the
  original session deferred). The planner has a third subagent, `builder-agent`;
  "build me a…" in chat, or the Tools tab, generates a small self-contained web
  tool (checklist / planner / tracker / calculator / form). Architecture:
  - Codegen (`agent-core/src/tools/builder.ts`) talks straight to the model
    (like extraction) — 1–2 completions for a full inline HTML doc; no plan
    step (a small model couldn't do the structured call reliably). Name comes
    from the HTML `<title>`.
  - Tools are served from a **separate HTTP server** (`tools/server.ts`, port
    `FAMILY_AGENT_TOOLS_PORT`, default 4174) with a strict CSP — a tool page
    cannot reach agent-core's routes, Ollama, or the internet.
  - "Open" runs the tool **inside the app** — single window, no external
    browser. Desktop embeds it in a full-window `<iframe>` (cross-origin +
    `sandbox` attr; the tools server's CSP `frame-ancestors` allows only the
    local app / localhost, nothing remote). Android loads it in an in-app
    `WebView` (`ToolWebViewScreen`). No Tauri window/webview IPC — the only
    Tauri capability the app uses is the directory picker.
  - **Persistence is server-side for every tool.** Static tools get disk-backed
    `GET/PUT /<id>/__state` from the Node tools server (`<tool dir>/data/<key>.json`);
    server tools get it from their Deno backend. Every served page also gets an
    injected `<base href="/<id>/">` + a shim that mirrors `localStorage` →
    `__state` — the cross-origin iframe's own `localStorage` is not durable
    across a webview restart, which used to silently wipe every "local" tool.
    A tool that calls `fetch('/__state')` (absolute) is handled too: the HTML
    rewrite makes it relative, and the server falls back to the same-origin
    `Referer` to find the tool id for any unprefixed request. See
    `docs/DECISIONS.md`.
  - A tool that needs cross-device shared state ("the whole family can…") gets
    a **Deno backend** run by `ToolSupervisor` under a deny-by-default sandbox:
    `--no-prompt --deny-import --allow-net=127.0.0.1:<own port>
    --allow-read=<tool dir> --allow-write=<tool dir>/data`, plus a v8 heap cap,
    stdin-EOF self-exit, and an idle sweep. Verified in `test/tools.test.ts`: a
    handler cannot read `/etc/hostname` or reach `:11434`. The model only ever
    writes `handler.ts`; the harness is ours. `.toolchains/deno/` holds the
    binary (auto-detected; `FAMILY_AGENT_DENO_PATH` overrides). No Deno → static
    tools still work, shared-state ones fail with a clear message.
  - Each server tool gets its **own SQLite database** (`node:sqlite`, a Deno
    builtin — no extra permission) at `<tool dir>/data/tool.db`, created and
    opened by the harness. It's isolated per tool: `--allow-write` only covers
    that tool's `data/` dir and `node:sqlite` disables `ATTACH`. The handler is
    passed `ctx.db` (raw `DatabaseSync`) for relational data and `ctx.store`
    (get/set a JSON blob, also backing `GET/PUT /__state`) which is now a `_kv`
    table on the same DB. A pre-SQLite tool's `data/<key>.json` files are
    imported into `_kv` on first start. Size is capped at ~64 MB
    (`PRAGMA max_page_count`). Tool deletion `rm -rf`s the dir, DB included.
    Verified in `test/tools.test.ts` (persists across a backend restart; legacy
    JSON blob migrates).
  - **Data inspector.** Read-only browsing of a tool's persisted data, on an
    "Inspect data" button on every ready tool (desktop full-area overlay).
    Server tools: `tools/dbInspect.ts` opens `tool.db` with `{ readOnly: true }`
    (agent-core has disk access; no proxy through the Deno sandbox) behind
    `GET /tools/:id/db`, `GET /tools/:id/db/rows`, and a SELECT-only
    `POST /tools/:id/db/query` — table rail + sortable paged grid + query box.
    Static tools (no db): `GET /tools/:id/db` + `GET /tools/:id/db/state?key=`
    expose the `data/<key>.json` `__state` blobs as pretty JSON. All routes
    scoped to the caller's own tools. Android not wired yet. See
    `docs/DECISIONS.md` → "Tool database inspector".
  - **Server tools are an API the chat assistant can call.** A build starts with
    a plan pass — the model decides `{ needsBackend, operations }` for the ask,
    so "a random recipe picker" becomes a server tool with `add_recipe` /
    `list_recipes` / `random_recipe` / `remove_recipe` rather than a dead-end
    display page (a "tip calculator" stays static). Then the model writes
    `operations.ts` (`[{ name, description, access, inputSchema, run }]`)
    implementing that list; the harness turns the one array into a real MCP
    server (`POST /mcp` —
    JSON-RPC 2.0 `initialize` / `tools/list` / `tools/call`), plain REST for the
    tool's own frontend (`GET|POST /api/<name>`), and `GET /__manifest`.
    agent-core is the MCP client (`tools/toolMcp.ts`), caches each tool's
    operation list to `<toolDir>/mcp.json` at build time, and a `tools-agent`
    subagent (`list_family_tools` + `call_family_tool`) lets the planner query
    and update the family's own trackers/inventories/logs from chat — "where's
    the winter tent?" is answered by calling the tool, with a `type:"tool"`
    reference chip. Writes get an `activity` line. Verified end-to-end against
    `gemma4:26b`: built an item tracker from one sentence, then chat recorded an
    item and looked it up, and the tool's own UI showed the same row. The MCP
    endpoint is also reachable via the tools server at `:4174/<id>/mcp` (no auth
    yet — external clients are future scope). See `docs/DECISIONS.md` → "Tools
    as an agent API (MCP)".
  - **Tools are improvable, not one-shot.** `iterateTool` regenerates a tool
    from its own prior code + the change asked for (via chat — builder-agent's
    `improve_tool` — or the desktop "Improve" box). A server improve is
    smoke-tested on a scratch port **against a copy of the tool's real data**
    (boots + `tools/list` + every read op called) before it replaces the running
    one, with one self-repair pass on failure; a broken improve leaves the
    working version and its `tool.db` untouched and records why. **Database
    migrations are automatic, best-effort**: the model is told to write guarded
    `ALTER TABLE ADD COLUMN` at the top of every op, and the real-data smoke test
    catches it when it forgets. The previous version + a `tool.db` copy are kept
    in `<toolDir>/prev/` for a one-step "Undo last change" (`POST
    /tools/:id/revert`), which also restores the data if the improve dropped a
    column. A `failed` tool is salvaged by improving it. An improve that asks to
    *save the user's own entries* **upgrades a display-only static tool into a
    server tool** with real storage + agent operations (downgrades back if the
    model produces none). The chat assistant now *sees* display-only tools too,
    so "add a recipe to my recipe randomiser" routes to improving the existing
    tool instead of "no such tool — build a new one?". New `tools` columns:
    `revision_count`, `revision_state`, `updated_at`. See `docs/DECISIONS.md` →
    "Improvable tools".
  - Kill switch: `FAMILY_AGENT_TOOLS=0`.
  - Reliability caveat: a smaller model produces a working simple HTML tool most
    of the time but not always; a bad build is marked `failed` with the error, a
    broken frontend still has the built-in `/__state` persistence, and a broken
    `operations.ts` falls back to no operations (the tool works, the assistant
    just can't use it). `gemma4:26b` generated clean multi-operation backends
    reliably in testing.
- `db.ts` now runs column migrations on startup (an older DB missing a newer
  column no longer breaks every write).
- Documents can be deleted, and a failed field-extraction shows a retry
  instead of a permanent "Extracting…" (`extraction_status` column).
- Scanned PDFs (no text layer) are now OCR'd page-by-page via the same
  tesseract.js path as a photo, capped at `PDF_OCR_MAX_PAGES`
  (`fileExtract.ts`). Text-layer PDFs still use the text layer.
- Optional OCR upgrade: set `FAMILY_AGENT_OCR_MODEL` (or the desktop Settings
  → "Document OCR" field) to a local Ollama vision model — `glm-ocr:latest`
  is the tested one (`ollama pull glm-ocr:latest`, ~2.2 GB). When set,
  scans/photos/image-PDFs are transcribed to Markdown by that model instead
  of tesseract; a missing/unreachable/over-budget model falls back to
  tesseract (verified: 404 and abort/timeout both fall back). Budget is
  `FAMILY_AGENT_OCR_TIMEOUT_MS`, default 180s.
  **Reality check:** on *this* CPU-only box GLM-OCR via Ollama 0.32.6 is
  impractically slow — a trivial 300×80 test image did not finish a single
  `/api/generate` call in 150s. The plumbing is correct and the fallback
  works, but this needs a GPU to be usable. The setting defaults to blank
  (built-in engine) for that reason. Also: OCR still runs on the synchronous
  upload path, so with a vision model set an upload blocks up to the budget;
  moving it to the background extraction pass is the real next step.
- **Multi-user master node** (the "per-family-member access control" next-step
  below, done). `agent-core` is now a real multi-user server: `auth.ts`
  (scrypt + bearer tokens), `users`/`sessions` tables, and a `ScopedStore`
  (`store.scoped(userId)`) that scopes every task/document/activity/tool query
  by `user_id`. `server.ts` has a `preHandler` auth hook, `/auth/*` +
  `/users` routes, one planner + one inbox watcher per account, and
  admin-only machine settings. First run: `GET /auth/status` → `needsSetup`
  → `POST /auth/bootstrap` (desktop shows a setup screen; it also reassigns
  any data from a migrated single-user DB). `agent-core` binds `0.0.0.0` and
  advertises `_familyagent._tcp` over mDNS (`bonjour-service`).
  - **desktop**: `main.ts` gates the app behind setup/login; a "Family" admin
    screen manages accounts; the rail shows the signed-in user + Sign out;
    machine settings are disabled for non-admins. Token in `localStorage`, a
    401 reloads to the login screen. 15/15 `test/api.test.ts` pass.
  - **android**: `AuthState` gates the UI (`PickServer` → `NeedLogin` →
    `Authenticated`). `ServerDiscovery` finds home servers on the LAN — mDNS
    (`NsdManager`) *plus* an active `/health` probe of the device's /24 and
    `10.0.2.2`, because the emulator doesn't forward multicast and some Wi-Fi
    blocks client-to-client mDNS; manual-address entry is the last resort.
    `LoginScreen` signs in; `SettingsStore` persists the session; a 401
    anywhere (`UnauthorizedException` → `AppViewModel.apiCall`) bounces back
    to login. Settings shows the account + Sign out. 11/11 unit tests pass.
    **Verified on the emulator**: discovery lists the desktop server, tapping
    it → login screen (screenshotted).
  - Verified by hand: `curl` bootstrap → login → two accounts, each sees only
    its own tasks; member gets 403 on `/users`; per-user inbox watchers start
    on account creation; mDNS record published. Full agent-core suite 91/91
    (incl. live-model integration).
  - **Not yet**: content *sharing* between accounts (the intended next phase —
    `ScopedStore` and a single DB were chosen partly to make it tractable);
    Android has no admin/user-management UI (desktop only); the tools server
    (4174) is still unauthenticated (id is the capability).
- **Document & task search (FTS5)**. The agent no longer answers "do we have
  the …" by dumping every row into the model — `document-agent` and
  `task-agent` have `search_documents` / `search_tasks` tools backed by
  SQLite FTS5 mirror tables (`db.ts`), kept in sync by triggers, `bm25()`
  ranked, with `snippet()` excerpts and `category` / important-date-range
  filters. `GET /documents/search` and `GET /tasks/search` expose the same
  thing over HTTP; `desktop/src/api.ts` and `android/.../FamilyAgentApi.kt`
  have client methods. Rationale (incl. why not Meilisearch/Typesense/
  OpenViking) in `docs/DECISIONS.md` → "Document & task search".
  - Verified: agent-core fast suite green (+29 tests across `db.test.ts`,
    `documentTools.test.ts`, new `taskTools.test.ts`, `server.routes.test.ts`);
    desktop `npm test` 21/21; android `testDebugUnitTest` 17/17. Full
    agent-core suite (with live-model integration) left running at handoff.
  - **Not yet**: no search box in either client UI — that needs a design pass
    against the two independent design systems and live-app verification. The
    client API methods are in place; wiring a UI is the remaining step.
- **Semantic + fuzzy document search** (follow-up to the above). Documents now
  also get: **fuzzy** matching (typo/substring tolerant) via a
  `documents_trigram` FTS5 mirror re-ranked by trigram (Dice) similarity; and
  **semantic** matching via a local Ollama embedding model
  (`nomic-embed-text` by default; `agent-core/src/embeddings.ts`,
  `document_embeddings` vector table, brute-force cosine). `GET
  /documents/search?mode=keyword|fuzzy|semantic|hybrid` (default **hybrid** —
  all three merged by reciprocal-rank fusion); the `search_documents` tool
  goes through the same `searchDocumentsSmart()`. Degrades to keyword+fuzzy
  when no embedding model is pulled — `FAMILY_AGENT_EMBED=0` turns semantic
  off entirely. Vectors built off every ingest path + a startup/settings-change
  backfill. `tasks` search stays keyword-only. Rationale in
  `docs/DECISIONS.md` → "Follow-up: semantic + fuzzy document search".
  - **Client UI shipped this time.** Both Documents screens have a search box
    + a Smart / Exact / Typo-tolerant / Meaning mode selector; results show a
    highlighted match snippet. Desktop `#document-search` in `main.ts`;
    Android search state on `AppUiState` + a segmented control in
    `DocumentsScreen.kt`. Empty query ⇒ the normal list.
  - Verified: agent-core fast suite green (225 pass / 1 skip; 231 / 1 with the
    semantic integration file); new `embeddings.test.ts` (28), `db.test.ts`
    +8, `server.routes.test.ts` +5; `semanticSearch.integration.test.ts` (6)
    **green against real `nomic-embed-text`**. Desktop `npm test` 33/33 (+2),
    typecheck + `vite build` clean; Android `testDebugUnitTest` 21/21 (+2),
    `assembleDebug` clean. **Verified live on both clients** against a running
    server with the model pulled: desktop drove all four modes (keyword typo
    → 0, fuzzy typo → hit, semantic paraphrase → right doc #1); Android on the
    emulator showed the search box, the mode selector, "N matches", and
    correctly-ranked results with snippets. `agents.integration.test.ts` 4/5 —
    its one failure reproduces on a clean checkout at HEAD (pre-existing
    small-model flakiness), see `docs/BUILD_LOG.md`.
- **"Tasks" is now "Events"** in both apps — a UI-label rename only. Routes,
  the `tasks` table, `task-agent`, and its tools are unchanged (see
  `docs/DECISIONS.md` → "Tasks renamed to Events").
- **Family chat + shared sticky board — the first cross-account features.**
  This is the "content sharing between accounts" that earlier entries listed
  as not-built, done for two surfaces:
  - **Chat**: 1:1 DMs and named Slack-style group channels. New tables
    (`channels`, `channel_members`, `messages`) on the base `Store`, all reads
    membership-checked by the requesting user id. Routes: `GET/POST /channels`,
    `GET /channels/:id`, `GET/POST /channels/:id/messages`, `POST
    /channels/:id/{members,read}`, plus `GET /family/members` (any user, name +
    username only). `@agent` / `@ai` in a message runs the mentioning user's
    planner and posts the reply in-channel as a `_agent_` participant; a
    `pending` placeholder message is filled in when the model returns. Delivery
    is short-interval polling (consistent with the rest of the app).
  - **Sticky board**: one shared family board + a per-user private board.
    `sticky_notes` on `ScopedStore` (private scoped by `user_id`, shared open
    to every member). Routes `GET/POST /notes`, `PATCH/DELETE /notes/:id`. A
    new `notes-agent` subagent (`list_sticky_notes`, `add_sticky_note`) lets
    the planner read the board and pin notes on request.
  - **The board is now a draggable corkboard.** Notes carry an `(x, y)`
    position (`sticky_notes.pos_x/pos_y`, migrated + scattered for an existing
    DB). Both clients drop the "write a note" text input: **+ Add note** pins a
    **blank** note that you edit in place (a note left blank is deleted).
    Dragging a note `PATCH`es `{x, y}` (no activity-log line — it'd flood).
    `listStickyNotes` orders by `updated_at ASC` so the note you last touched
    renders on top. See `docs/DECISIONS.md` → "Sticky board → physical
    corkboard".
  - Clients: desktop gets **Messages** + **Board** nav items and views;
    Android gets `Destination.Messages` (+ a nested `conversation/{id}` route)
    and `Destination.Board`, with an unread badge on the drawer item.
  - **Not yet**: no per-message references in channels; no @-mention of a
    specific person (only `@agent`); no push/notification when the app is
    closed (poll only while open).
- **Chat replies show clickable references.** When the assistant used a task
  or document, `/chat` returns `references: [{type, id, label}]` (collected via
  an `onReference` hook on the retrieval tools). Desktop renders them as chips
  under the reply that open the item in a **right-hand side panel**; Android
  renders `AssistChip`s that open a **bottom sheet**. The same panel/sheet
  backs a new **Preview** button on each document. `GET /tasks/:id` and `GET
  /documents/:id` were added for it.
- **Document rename.** Each document has a **Rename** control (desktop: inline
  editor on the row; Android: a dialog). The user can type a name, or tap
  **Suggest with agent** → `POST /documents/:id/suggest-name` runs a
  single-purpose model call (`agents/rename.ts`, planner-bypass like
  `extraction.ts`) and fills the field with a proposed name. Nothing is applied
  until the user confirms, which `PATCH /documents/:id`es with
  `by: "document-agent"` so the activity log distinguishes an AI name from a
  hand-typed one. There is deliberately no planner tool that renames — see
  `docs/DECISIONS.md` → "Document rename".
- **Small UX changes**: desktop document upload auto-starts on file pick (the
  separate Upload button is gone); the desktop **Sign out** button moved from
  the sidebar to Settings → Your account (Android already had it in Settings).
- **Default data dir moved** from `agent-core/data/` to
  `~/.local/share/family-agent` (`$XDG_DATA_HOME/family-agent`), still
  `FAMILY_AGENT_DATA_DIR`-overridable. A dev box re-runs setup against the new
  dir, or points the env var back. See `docs/DECISIONS.md`.
- **Desktop UI polish pass (round 2).** No behaviour changes — closes the gap
  between what the desktop showed and its non-technical audience. New
  `desktop/src/format.ts` centralises human formatting: ISO dates → "Fri, Sep 8
  · 3:30 PM", 24h times → "3:30 PM", timestamps → "5 min ago" / "Yesterday",
  internal actor ids → words ("task-agent" → "Events"). Applied to the Events
  list (now sorted soonest-first with a **Done** divider and an overdue tint),
  the calendar chips, the Activity log (regrouped into a dense day-headed
  timeline), and the reference/side panels. Tool cards no longer leak
  developer terms: `add_loan` / `list_open_loans` render as "record that
  someone borrowed an item" / "list items that are still out", the raw build
  error is replaced with plain guidance, and the misleading "shared" pill is
  gone. Secondary actions (Preview, Rename, Improve, Inspect data…) and the
  per-field Settings **Save** buttons are quiet by default and only take the
  blue accent on hover, so a card / page isn't a wall of blue. Chat-channel
  message bubbles hug their content instead of stretching full-width; the
  Messages view fills the width instead of sitting in the narrow centred
  column. The DB inspector's "nothing stored yet" state is a centred message,
  not a stranded status line over a blank panel. Hard-coded hex colours in
  `style.css` were folded into `:root` tokens (`--accent-soft-hover`,
  `--danger-soft-hover`). Activity-log strings in `agent-core` were softened
  too ("Ingested X" → "Added X", dropped "(revision N)").
- **Scheduled routines — "cron for the family agent".** A **routine** is a
  saved instruction the assistant runs on a schedule: a morning briefing, a
  bill nudge, a weekly review, a one-off future reminder. Per-user like
  tasks/documents. `agent-core/src/routines.ts` owns the trigger math
  (hand-rolled 5-field cron + next-run in local time; also `once` and plain
  `every` intervals) and a process-wide `RoutineScheduler` — a 60s tick feeding
  a **serialized** run queue (the model is slow and single-threaded), with a
  **catch-up policy** for triggers missed while the laptop slept (run-once if
  fresh, else skip forward). New tables `routines` / `routine_runs` on
  `ScopedStore`; routes `GET/POST /routines`, `GET/PATCH/DELETE /routines/:id`,
  `GET /routines/:id/runs`, `POST /routines/:id/run` (runs now, awaits like
  `/chat`). Each run always records a `routine_runs` row + an `activity` line;
  optionally it also posts the output into a family chat channel as `@agent`
  (`deliverChannelId`). An action runs the full **planner** or one specialist
  (`task`/`document`/`notes`/`tools`) — **never `builder-agent`** (a routine
  doesn't write code unattended; enforced structurally, not by prompt).
  Authoring: a `routine-agent` subagent + a `/schedule` (alias `/remind`)
  forced-chat turn, both taking friendly schedule fields. `FAMILY_AGENT_ROUTINES=0`
  disables the whole feature (endpoints 404, both clients hide the screen).
  - **Both clients shipped.** Desktop: a "Routines" nav item + view — a card per
    routine (name, schedule sentence, on/off switch, next/last run, Run now /
    Edit / Delete, expandable run history) and a create/edit form whose schedule
    picker (Every day / week / month / few hours / Once / cron) round-trips a
    stored trigger back into its fields (`#view-routines` in `main.ts`).
    Android: `Destination.Routines` + `RoutinesScreen.kt` — the same card list
    and a `ModalBottomSheet` create/edit form; drawer item hidden when
    `/health.routinesEnabled` is false. Both add a `/schedule` slash-command
    hint.
  - Verified: agent-core `test/routines.test.ts` + `test/routines.routes.test.ts`
    (28 new tests); full fast suite 312 pass / 1 skip; desktop typecheck +
    `vite build` + 35 tests; Android `testDebugUnitTest` 25 pass (+3) +
    `assembleDebug`. Live: `/schedule` NL authoring produced a correct routine
    (`gemma4:e2b`), a 1-min `every` routine ran on schedule (~16s/run, output
    captured), **desktop** drove create/edit/pause/delete and **Android on the
    emulator** drove the drawer item, list, create, and an edit whose stored
    cron round-tripped back into the weekly picker.
  - **Not yet** (v2+): data-relative triggers ("N days before an Event /
    document date"); event-driven triggers ("when a `medical` document lands");
    direct tool-operation actions; OS notifications (chat-channel delivery is
    the v1 stand-in). See `docs/DECISIONS.md` → "Scheduled routines".
- **Web access + shell/file-processing** — two capabilities that take the agent
  past its own database, each **off by default**, each an env-var switch, each
  in `/health` (`web`, `shell`). Full rationale in `docs/DECISIONS.md` → "Web
  access and shell/file-processing".
  - **Web** (`agent-core/src/web/`): a `research-agent` subagent with
    `web_search` + `open_page`. `FAMILY_AGENT_WEB_SEARCH_PROVIDER` picks the
    backend (`searxng` self-hosted / `tavily` / `brave` / `ddg` / `none`).
    **`src/web/fetch.ts` is the one and only egress point** — enforced by
    `test/web.egress.test.ts` — with an SSRF guard (private/loopback/link-local/
    CGNAT ranges blocked, redirects not followed) so a model-chosen URL can't
    reach the family's private network. Page text is framed as untrusted; the
    agent has no write tools. Replies cite sources via a new `link` reference
    chip. `research` is also a valid **routine** action agent (weather/news
    briefings).
  - **Shell** (`agent-core/src/shell/`): a `workshop-agent` that runs
    allow-listed CLI tools (qpdf, ffmpeg, imagemagick, jq, csvkit, pandoc, …)
    over a per-user file workspace inside a **bubblewrap sandbox with no
    network**. `FAMILY_AGENT_SHELL=1` + bubblewrap required (probed at startup;
    off if the sandbox can't be created). The model gets `run_command({ tool,
    args })` — an argv array, no shell — plus `import_document` / `save_output`
    to move files in and out of the family's documents. `run_shell` (arbitrary
    bash, still sandboxed) behind `FAMILY_AGENT_SHELL_UNRESTRICTED=1`.
  - Both clients: `/web` and `/run` slash commands (desktop hides them when the
    capability is off); `web`/`shell` fields on `/health`; link reference chips
    open the page.
  - Verified: agent-core fast suite 327 pass / 1 skip (+15: `web.fetch`,
    `web.egress`, `shell`); desktop typecheck + build + 35 tests; Android
    compile + `assembleDebug`. Sandbox isolation confirmed by hand (a command
    can't see `/etc`, `/home`, or the network); `fetchPage` extracts real pages
    and blocks `169.254.169.254`; `runTool` with `jq` computes a CSV column sum
    correctly. Small-model (`gemma4:e2b`) multi-step orchestration of these is
    unreliable — the tooling is ready for a bigger model, same as builder tools.
  - **Not yet**: an admin "capabilities" screen (env-var only for now); web in
    a "sources" side panel; OS notifications.
- **Code sandbox (`run_code`)** — a stateless "run this snippet, give me the
  answer" tool so the assistant can do exact arithmetic / date math / small
  data analysis instead of guessing (a 2B model gets "split $84 three ways"
  wrong). `agent-core/src/compute/run.ts`: **QuickJS compiled to WebAssembly**
  (`quickjs-emscripten`) — ~1 MB, no native dependency, no build step,
  cross-platform, and the module has **no syscalls at all** (no fs / network /
  clock / randomness). Memory + stack + 3 s wall-clock + output-size caps; the
  interrupt handler stops runaway loops *and* catastrophic regex backtracking.
  Bound directly onto the planner and `document-agent` (compute a value read
  off a bill), plus a `/calc` (alias `/compute`) forced turn. **On by default**
  (`FAMILY_AGENT_COMPUTE=0`; `/health.compute`) — unlike web/shell it widens no
  trust boundary. Both clients gained the `/calc` slash hint.
  - Verified: `test/compute.test.ts` (13 — result/logs/input/NOW, errors
    reported not thrown, every cap enforced, no ambient globals, no state leak);
    fast suite 340 pass / 1 skip; desktop typecheck + build + 35 tests; Android
    26 API tests + APK. Live (`gemma4:e2b`): `/calc split a $128.40 bill 4 ways
    with 20% tip` → "$38.52"; the plain planner picked `run_code` unprompted for
    "days between today and 2026-12-25" → 109.
- **Desktop composer polish + Messages parity.**
  - **Chat input**: the placeholder is a single line again ("Ask anything, or
    type / for a command"); the textarea starts one line and auto-grows to
    **three**, then holds that height and scrolls; an **expand button** appears
    once there's more than three lines and toggles a ~48vh view. Shared helper
    `wireAutoGrow` in `main.ts` (`.chat-form textarea { max-height: calc(1.5em*3
    + 14px) }`, `.chat-form.is-expanded` bumps it). The Send/Stop buttons no
    longer stretch to the full composer height.
  - **Slash-command chip**: once a "/command" is chosen from the "/" menu
    (or you type "/name " with a trailing space) it becomes a small pill
    (`.composer-chip`) at the start of the composer, so the command and the
    message text read as two separate things. The textarea then holds only the
    message; Backspace at the very start removes the whole chip (never a
    partial "/comman"). On send the wire form is rebuilt as `/cmd text`. Same
    in Chat and Messages via the shared `wireSlashMenu` helper.
  - **Board**: the corkboard surface is now a plain **white** panel
    (`var(--surface)`) instead of the warm cream — matches the
    white-hairline-card design system. (The faint dot grid it briefly carried
    was later dropped on both clients — it read as noise.)
  - **Messages composer** now has the SAME plumbing as Chat: voice input (mic
    button, gated on `/health.asrEnabled`), `/` command autocomplete
    (`#message-slash-menu`), the one→three-line auto-grow + expand button, and a
    `?` slash-help button in the conversation head. All via the shared
    `wireMic` / `wireSlashMenu` / `wireAutoGrow` helpers.
  - **Server**: `POST /channels/:id/messages` now invokes the assistant on a
    leading `/` command too (not only `@agent`), routing to the matching
    specialist via the shared `runForcedAgentTurn()` — so the agent works the
    same in a 1:1 chat or `@`-mentioned in a conversation. The user's own
    message keeps the `/` (honest transcript).
  - Verified: agent-core fast suite 346 pass / 1 skip (+3 route tests: `/`
    command in a channel invokes the assistant; a plain message does not);
    desktop typecheck + build + 35 tests. **Live**: chat input 1→3-line cap +
    scroll + expand toggle (measured via DOM); the board renders white; the
    Messages composer shows the mic + `/` autocomplete, and `/calc 15% of 80`
    sent in a DM got an "Assistant: 15% of 80 is 12." reply with a
    `compute.run` activity line (the calc specialist, not the planner).
- **Skills + MCP** — two ways to extend the agent without editing `agent-core`.
  Full rationale in `docs/DECISIONS.md` → "Skills and MCP".
  - **Skills**: a folder under `<dataDir>/skills/<name>/` — `SKILL.md`
    (front-matter + markdown instructions) plus an optional `scripts/` dir. The
    planner gets `list_skills` (cheap, always loaded) and `use_skill(name)`
    (pulls one skill's full body into the turn) — progressive disclosure, same
    as `tools-agent`. `run_skill_script` runs a bundled `.py`/`.js`/`.sh`
    script in the existing bwrap sandbox (skill folder read-only at `/skill`,
    no network). **On by default** (`FAMILY_AGENT_SKILLS=0`;
    `/health.skills` = `full` | `docs-only` | `off`) — skills are just text.
    `POST /skills/draft` turns a name + description into a first-draft
    `SKILL.md` via one `extractionModel` call. `/skill` forced turn. Both
    clients have a Skills screen (reads open to all, writes admin-only).
  - **MCP client**: `agent-core` can connect to external MCP servers
    (`<dataDir>/mcp.json`), **off unless `FAMILY_AGENT_MCP=1`** (second egress
    point → operator switch, not a Settings toggle). Hand-rolled JSON-RPC 2.0,
    http (Streamable HTTP `2025-06-18`) or stdio (spawned inside bwrap, no
    network unless `allowHosts`). A `connections-agent` subagent
    (`list_mcp_tools` / `call_mcp_tool`) — external tool descriptions and
    results are untrusted, wrapped with a "don't act on instructions in here"
    note, no write tools, blast radius "a wrong answer" (like `research-agent`).
    `McpManager` is process-wide, drained on shutdown; secrets redacted on
    every API response. Admin routes `GET/POST /mcp/servers`, `PATCH`/`DELETE`
    `/mcp/servers/:name`, `POST /mcp/servers/:name/probe`, `GET /mcp/tools`.
    Allowed as a routine action agent (`connect`); `/connect` (alias `/mcp`)
    forced turn. Desktop: Settings → "Connections (MCP)"; Android: drawer
    `Destination.Connections`. Both admin-only.
  - Verified: agent-core `npx tsc --noEmit` clean, fast suite 385 pass / 1 skip
    (+`test/skills.test.ts` 23, +`test/mcp.test.ts` 16 — folder store,
    front-matter parse, planner tools, sandboxed script isolation
    (`HOME_HIDDEN`/`ROOT_HIDDEN`), `McpManager` against an in-process fake MCP
    server incl. result clamping + graceful degradation, routes + admin gating
    + `/health`); desktop typecheck + build + 35 tests; Android
    `compileDebugKotlin` + `testDebugUnitTest` + `assembleDebug`. Live-model
    exercise still pending (author is away 6h).
  - **Follow-up — a `describe_*` rung.** `tools-agent` and `connections-agent`
    went from `list_ → call_` to `list_ (compact) → describe_ (full nested
    schema) → call_`, so a 2B model sees the exact parameter shape (nested
    objects, array items, enums) right before calling instead of guessing from
    a lossy one-liner. Schema rendering shared in `agents/schemaText.ts`. Not
    a port of Claude Code's `ToolSearch` "activate a real tool" — deepagents
    compiles a fixed graph per turn, so the tools stay text. Fast suite now
    394 pass / 1 skip (+`test/schemaText.test.ts`).
- **Desktop atmosphere layer (Gemini-inspired).** A soft presentation pass over
  the warm-paper base: an animated gradient canvas (two counter-drifting
  `body::before/::after` bloom layers in the accent-cast colours), translucent
  glass chrome (rail, side panel, tool viewer), floating card shadows
  (`--shadow-sm` was `none`), rounder corners (`--r-lg` 16 / `--r-xl` 22), and
  springy view/bubble transitions — all frozen by `prefers-reduced-motion`. The
  identity (`#f6f5f4`, `#0075de`, Inter) is unchanged; no cool-palette shift.
  Built as `:root` token edits + one appended block in `desktop/src/style.css`
  (no JS), so it's a one-commit revert. Android untouched (flat paper). Verified
  in the browser across Chat, Events, Board, Routines, Settings, Documents, and
  a chat conversation. `DESIGN.md` and `docs/DECISIONS.md` updated to record the
  deliberate divergence.
  - **Follow-up — floating, collapsible sidebar.** `.rail` went from a docked
    244px grid column to a `position: fixed` glass panel with a gutter on all
    sides. Three states on `#app` (`--rail-space` per state): expanded →
    `rail-collapsed` (icon-only ~66px) → `rail-hidden` (off-screen, a floating
    `.rail-reveal` button + `Ctrl/Cmd+B` bring it back). `.content` reserves
    `padding-left: var(--rail-space)`. `setRailState()` in `main.ts` persists to
    `localStorage`. Verified in-browser: all three states, cycling, and reload
    persistence.
  - **Follow-up — Android converged onto the desktop look.** The Android app's
    standalone "Playful Color" system (indigo/pink/cyan, Nunito, light + dark)
    is retired. `Theme.kt` rewritten to mirror the desktop tokens (`#f6f5f4`
    canvas, `#0075de` accent, Inter + Source Serif, shapes 12/16/20/26);
    **dark mode dropped** (light only, no `values-night/`); `ui/Atmosphere.kt`
    adds the animated gradient canvas (the Compose counterpart of
    `body::before`); opaque floating surfaces over it (no Android backdrop
    blur → no glass); springy `NavHost` transitions; active drawer item →
    `accent-soft`.
    `AppAccents` kept as a compat shim (remapped). Verified on the emulator
    across login, Chat, Messages, drawer, Board, Events, Settings —
    `compileDebugKotlin` + `testDebugUnitTest` + `assembleDebug` green.
    `android/DESIGN.md` rewritten; `CLAUDE.md` / `docs/DECISIONS.md` updated.
  - **Follow-up — Android app bar removed.** The `AppTopBar` (menu button +
    wordmark + divider, ~56dp) is gone; a single **floating menu button**
    (opaque white, top-left) opens the drawer, hidden on the tool WebView and
    inside a conversation. `ScreenScaffold` top padding 16→58dp to clear it
    (also fixes the pre-auth screens' status-bar overlap). Also: the chat/
    messages composer is one line on init (shortened placeholder + `maxLines=1`
    on it; still grows to 4). Translucent-glass surfaces were tried and
    reverted — no cheap backdrop blur on Android, so a flat translucent panel
    just ghosts the content behind it; the drawer, menu button, composers and
    cards are all opaque `surface`, floating over the gradient via shadows
    like the desktop's opaque cards. Verified on the emulator.
  - **Follow-up — Copy button on replies.** Both apps show a small "Copy"
    button under every assistant / `@agent` reply that copies the raw Markdown
    source (desktop `makeCopyButton` / `appendBubbleCopy` in `main.ts`; Android
    `CopyButton` in `ui/Components.kt`). Wired into Chat and family-chat.
    Verified against real model replies on both platforms (a Markdown list
    rendered as bullets — confirming rendering is fine).

- **macOS: the desktop app now builds and packages as a self-contained `.app` /
  `.dmg`.** It was Linux-only (`deb`/`appimage` targets; `main.rs` called
  `libc::PR_SET_PDEATHSIG`, which is Linux-only in the `libc` crate → the mac
  compile failed).
  - `main.rs`: the `PR_SET_PDEATHSIG` block is now `#[cfg(target_os = "linux")]`
    (on macOS the graceful shutdown handlers + `kill_stale_agent_core()` cover
    sidecar cleanup); `is_agent_core_pid()` gained a `ps -o command=` check for
    macOS (no `/proc`).
  - **Bundled sidecar** so a distributed app is self-contained.
    `desktop/scripts/prepare-sidecar.sh` stages `agent-core/dist` + a production
    `node_modules` + the `node` binary under `desktop/src-tauri/sidecar/`
    (gitignored, content-stamped, idempotent); `tauri.conf.json` ships it as
    `bundle.resources`; `resolve_agent_core()` in `main.rs` prefers
    `resource_dir()/sidecar/{node,agent-core}` and falls back to the repo
    checkout + system `node` for dev.
  - `tauri.conf.json`: `app`/`dmg` bundle targets, `bundle.macOS`
    (`minimumSystemVersion` 12, `Entitlements.plist`, ad-hoc `signingIdentity`).
    New `Info.plist` (`NSMicrophoneUsageDescription` — a bundled `.app`
    hard-crashes on the Chat mic button without it) + `Entitlements.plist`.
    `icon.icns` regenerated from an upscaled `logo.png`.
  - Verified on macOS 26 (arm64): `npm run typecheck` + `npm test` green;
    `cargo build`; `npm run tauri:dev` (window renders, sidecar spawns, a stale
    sidecar from a prior run is reaped); `npm run tauri:build` →
    `Family Agent.app` (~765 MB) that launches, spawns the **bundled** sidecar,
    serves `/health`, and shuts it down with no orphan; `CI=true tauri build`
    (→ `tauri:build:mac` npm script) also produces the `.dmg` (plain
    `tauri build` makes the `.app` but the DMG's Finder-window AppleScript step
    fails in a headless session).
  - **Not yet**: the `.app`/`.dmg` is **ad-hoc signed, unnotarized** — on another
    Mac it opens only via right-click → Open. Notarization needs a Developer ID
    cert. The Linux `.deb`/`.appimage` still carry the pre-existing "sidecar is a
    compile-time repo path" limitation (unchanged).

- **Native iOS app (`ios/`).** A full-parity SwiftUI clone of the Android app —
  all 12 screens (Chat, Messages + Conversation, Events with list/day/3-day/week/
  month views, Documents + search + upload + PDF preview, Board, Tools, Routines,
  Skills, Connections, Vault, Activity, Settings), plus voice input
  (`AVAudioEngine` → 16 kHz WAV, push-to-talk), sealed generated-card WebView,
  live tool-call steps strip, chat history sessions, image attachments. Design:
  same warm-paper "Notion" palette + animated gradient (`Atmosphere.swift`,
  `TimelineView`+`Canvas`), **Apple Liquid Glass** on iOS 26 (`glassEffect`,
  glass toolbars/sidebar/composer) behind `#available(iOS 26)` with a
  `.ultraThinMaterial` fallback down to **iOS 18**. Navigation is a
  `NavigationSplitView` (adaptive glass sidebar) rather than Android's drawer.
  - Structure: hand-authored `project.pbxproj` using Xcode 16+
    file-system-synchronized groups (builds headless with `xcodebuild`, no
    "open in Xcode once" step); one SPM dependency (`swift-markdown-ui`);
    `AppModel` is one `@MainActor @Observable` object mirroring `AppUiState` +
    `AppViewModel`; `FamilyAgentAPI` is a `Sendable` URLSession client mirroring
    `FamilyAgentApi.kt`; `ServerDiscovery` uses `NWBrowser` + an active `/health`
    probe of the device /24; the token lives in the Keychain. Builds clean
    (0 warnings) under Swift 6 `SWIFT_STRICT_CONCURRENCY=complete`.
  - Verified on the iOS 26.5 simulator against a live `agent-core` + remote
    `gemma4:26b`: discovery (Bonjour + probe both find the server), sign-in,
    Settings/Events/Board/Documents/Vault render with real seeded data, and a
    full chat turn → Markdown reply + a "4 tool calls" steps strip (the planner
    delegated to the task and notes agents). Separately built + run on an
    iOS 18.6 simulator to confirm the material fallback + non-glass toolbar.
  - **Not verified**: voice transcription / text-to-speech end to end (the
    remote Ollama has no Whisper/Kokoro — the UI + error paths render, the
    result errors); a real device (simulator only); the iPad layout beyond a
    quick check.
  - See `ios/README.md`, `CLAUDE.md` → "Native iOS app", and `docs/DECISIONS.md`
    → "Cloning the Android app to native iOS" / "macOS desktop packaging".
