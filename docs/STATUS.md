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
agent-core/   Node/TS backend — local HTTP API, SQLite storage, the deepagents
              planner + task-agent/document-agent subagents, Ollama client.
desktop/      Tauri v2 app. Spawns agent-core as a local sidecar process.
              Chat / Tasks / Documents / Activity UI.
android/      Kotlin + Jetpack Compose companion app. Same four screens plus
              Settings (server URL). Talks to agent-core over plain HTTP.
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
npm test    # from repo root: runs agent-core (30 tests, ~3-5 min, needs Ollama+gemma4:e2b) then desktop (6 tests)
cd android && ./gradlew testDebugUnitTest   # 5 tests, no device needed
```

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
3. Pick up the deferred pieces in whatever order matters most: Tailscale
   transport, the sandboxed builder/scratch-tool agent (this one deserves a
   supervised build, not an autonomous one, given what it can do), the
   compute mesh, per-family-member access control.

Later changes (not part of the original autonomous session):
- UI redesign of the desktop and Android apps ("Clean & calm" design system,
  shared tokens — `desktop/src/style.css` and `android/.../ui/theme/Theme.kt`).
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
    `WebView` (`ToolWebViewScreen`, JS + DOM storage on so localStorage tools
    work). No Tauri window/webview IPC — the only Tauri capability the app
    uses is the directory picker.
  - A tool that needs cross-device shared state ("the whole family can…") gets
    a **Deno backend** run by `ToolSupervisor` under a deny-by-default sandbox:
    `--no-prompt --deny-import --allow-net=127.0.0.1:<own port>
    --allow-read=<tool dir> --allow-write=<tool dir>/data`, plus a v8 heap cap,
    stdin-EOF self-exit, and an idle sweep. Verified in `test/tools.test.ts`: a
    handler cannot read `/etc/hostname` or reach `:11434`. The model only ever
    writes `handler.ts`; the harness is ours. `.toolchains/deno/` holds the
    binary (auto-detected; `FAMILY_AGENT_DENO_PATH` overrides). No Deno → static
    tools still work, shared-state ones fail with a clear message.
  - Kill switch: `FAMILY_AGENT_TOOLS=0`.
  - Reliability caveat: `gemma4:e2b` produces a working simple HTML tool most of
    the time but not always; a bad build is marked `failed` with the error, and
    a broken custom backend falls back to the built-in `/__state` persistence.
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
