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
- First live-model run against gemma3n:e2b failed outright — see
  `docs/DECISIONS.md` for the full error and the qwen2.5:3b swap.
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

## Final state

- 15/15 agent-core tests passing (13 unit, 2 live-model integration).
- 5/5 Android unit tests passing.
- Desktop: Rust build clean, frontend build clean, full HTTP-level
  end-to-end flow manually verified against the live model; GUI not
  visually confirmed (tooling limitation in this environment, not a known
  defect).
- Android: builds and unit-tests clean, produces a real APK; never run on a
  device or emulator.
- iOS: not attempted, per explicit instruction.
