# Status — start here

Built autonomously in one unsupervised session per instruction ("act
autonomously, don't ask me anything, I'll be back in 6 hours"). This is the
entry point for reviewing it — human or AI. Read `docs/DECISIONS.md` next for
every judgment call made along the way (most importantly: the requested test
model, gemma3n:e2b, doesn't work for this architecture and was swapped —
that's not a silent substitution, it's explained there with the exact error).
`docs/BUILD_LOG.md` has the blow-by-blow of what broke and how it was fixed,
in case anything below looks surprising.

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

## What actually works, verified by hand

- **agent-core**: 15/15 tests pass (13 unit, 2 against the real local
  model). Full HTTP flow smoke-tested manually: create a task via `/chat`
  in natural language, ingest a document and watch it get classified with a
  category/summary/dates within a few seconds, list activity and see the
  real audit trail. `qwen2.5:3b` via Ollama, running locally, nothing
  leaves the machine.
- **desktop**: builds clean, launches, spawns agent-core correctly, survives
  a hard-kill of the parent process without orphaning the Node sidecar
  (this was a real bug, found and fixed — see BUILD_LOG). The UI has *not*
  been visually confirmed — this environment couldn't screenshot the actual
  window (see DECISIONS.md). Please look at it.
- **android**: builds clean, 5/5 unit tests pass, produces a real installable
  APK. Has never been run on a device or emulator — no emulator was set up
  in the time available. If you want to actually try it, you'll need to
  sideload `android/app/build/outputs/apk/debug/app-debug.apk` onto a real
  device (or set up an AVD) and, in Settings, point it at your desktop's LAN
  IP and port 4173.

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

```bash
# 1. Ollama must be running locally with qwen2.5:3b pulled
ollama serve &
ollama pull qwen2.5:3b

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
cd agent-core && npm test          # 15 tests, ~20-25s, needs Ollama+qwen2.5:3b running
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

1. **Look at the desktop UI** — this is the one thing that was built but
   never actually seen.
2. **Set up an Android emulator** (or sideload the APK to a real phone) and
   confirm the app actually renders and talks to a desktop instance over
   the LAN.
3. Decide whether `qwen2.5:3b` is the right permanent default, or whether
   it's worth trying a tool-calling-capable Gemma variant if/when one
   exists, or a different small model entirely.
4. Pick up the deferred pieces in whatever order matters most: Tailscale
   transport, the sandboxed builder/scratch-tool agent (this one deserves a
   supervised build, not an autonomous one, given what it can do), the
   compute mesh, per-family-member access control.
