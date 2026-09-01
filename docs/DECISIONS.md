# Decisions made autonomously

This build was done unsupervised (6-hour window, no check-ins) per explicit
instruction. Every place where I deviated from the brainstormed architecture,
or made a call the user didn't specify, is recorded here rather than buried
in commit messages. Read this before trusting any behavior that looks odd.

## Model: gemma3n:e2b → qwen2.5:3b

**Requested:** gemma3n:e2b, "for testing purposes."
**Shipped default:** qwen2.5:3b (`FAMILY_AGENT_MODEL` env var overrides it).

Confirmed by hand, not assumed: Ollama rejects gemma3n:e2b for tool-calling
outright —

```
MiddlewareError [ResponseError]: registry.ollama.ai/library/gemma3n:e2b does not support tools
```

This app's entire agent architecture (deepagents' planner → subagent
delegation → tool calls) depends on function-calling support. Gemma 3n isn't
in Ollama's tool-calling-capable set at all; this isn't a size issue, it's a
template/capability gap. qwen2.5:3b is the smallest widely-used model
confirmed to support tools reliably in Ollama, and was pulled and used for
every test in this build (`ollama pull qwen2.5:3b`, ~2GB).

gemma3n:e2b is still pulled locally if you want to experiment with it under a
different, non-tool-calling prompting strategy (plain ReAct-style text
parsing) — that would be a real rearchitecture of the agent loop, not a
config change, so it wasn't attempted here.

## Two subagents shipped, not four

The architecture notes (`docs/architecture-notes.html` §02) call for
document, schedule, task/misc, and builder subagents. This build has
**document-agent** and **task-agent** only. Schedule reasoning folds into
task-agent for now (a task can carry a due date; there's no calendar-conflict
logic). The builder/sandbox agent — the scratch-tool-generation feature from
§03 — is not implemented at all: it means arbitrary local code execution and
a local web server, and standing that up unsupervised, with no one available
to review the sandbox boundary before it runs, was judged not worth the risk
for this pass. Everything in §03 (planner-invoked tool, ephemeral/persistent
lifetimes, tailnet-only binding) is still the right design — it just isn't
built.

## No compute mesh, no Tailscale, no bundled runtime

§04–§06 of the architecture notes (phone sync transport, local-by-default
grant policy, worker-pool compute mesh, bundled inference runtime) are
**not** implemented. This build:

- Talks to Ollama directly (the "bring your own endpoint" path from §06),
  not a bundled managed-download runtime.
- Has no Tailscale wiring. The Android app takes a plain server URL
  (`http://<lan-ip>:4173`) entered by hand in Settings. Desktop-to-agent-core
  traffic is `127.0.0.1` only.
- Has no worker-node dispatch. There is exactly one inference target
  (whatever `OLLAMA_BASE_URL` points at).

The local-by-default-cloud-by-grant *policy* is still true in spirit —
nothing in this codebase calls any cloud API, and `config.ts` documents that
explicitly — but there's no grant mechanism to test because there's no cloud
model wired up at all.

## Short ids instead of UUIDs

Tasks and documents get 8-character Crockford-base32 ids
(`shortId()` in `agent-core/src/db.ts`), not `randomUUID()`. Found by
testing, not by guessing: the first live-model run had the planner
successfully call the `task` delegation tool, but transcribe the document id
wrong mid-string (`d7a1677b-3f72-...` became `...3f772-...`) when copying it
from the prompt into the tool-call arguments. A 3B model reproducing a
36-character random string verbatim is not a reliable interface. Shorter,
denser ids reduce that failure mode; they don't eliminate it if a user-facing
flow ever requires the model to transcribe an id from free text (worth
watching for as the app grows).

## Document extraction bypasses the planner

`agent-core/src/agents/extraction.ts` binds a single `save_extraction` tool
directly to the model and calls it once, right after ingest — it does not go
through `createDeepAgent`'s planner → `task` tool → document-agent subagent
path that the architecture notes describe for conversational requests.

Reasoning: that multi-hop path is exactly what produced the id-transcription
bug above, and ingest is a deterministic, no-user-in-the-loop system event,
not a conversation. There's no reason to make a 3B model copy an id by hand
when the code already knows which document it just created — the tool's
schema is built with the id captured in a closure instead. The
conversational planner (`agents/index.ts`) still uses the full
subagent-delegation path for `/chat`, since that's the case where a user
might genuinely ask about an arbitrary existing document by name and the
flexibility is worth the (retry-tolerant) risk.

One retry is built into both paths — `askFamilyAgent` and
`extractDocument` — because a 3B local model on CPU occasionally returns an
empty final message with no tool call on the first attempt. This was
observed directly (see docs/BUILD_LOG.md), not added defensively.

## CORS opened, not restricted

`agent-core` sets `origin: true` for CORS. The Tauri webview and agent-core
are different origins from a browser's perspective even though both are on
`127.0.0.1`. Since nothing in this app's trust model treats "different
localhost origin" as a security boundary — the whole server is meant to be
reachable by exactly the desktop UI and, eventually, the phone — restricting
CORS would add friction without adding protection. If a tailnet/relay
transport is added later (§04), this should be revisited alongside whatever
auth that transport introduces.

## Sidecar process cleanup: PR_SET_PDEATHSIG

Found by testing: killing the Tauri process (`kill -9`, or a crash) orphaned
the Node `agent-core` child — the graceful `on_window_event(Destroyed)`
handler in `main.rs` never runs if the parent dies before the Tauri event
loop gets to process that event. Fixed with `libc::prctl(PR_SET_PDEATHSIG,
SIGTERM)` in a `pre_exec` hook on the spawned child (Linux-only, gated behind
`cfg(unix)`), so the kernel kills the child the instant the parent dies, by
any means. Verified by hand: launched the app, confirmed the sidecar was
listening, `kill -9`'d the parent, confirmed the sidecar was gone within the
poll window (`ss -tlnp` on port 4173 empty, no orphaned `node` process in
`ps aux`).

## Toolchains installed without sudo, without Docker

No passwordless sudo was available, and the Docker daemon wasn't running
(and starting it needs sudo too) — so system package installation and
containerized builds were both off the table. Instead:

- **JDK 17** (Temurin) and **Android cmdline-tools / platform-tools /
  platform 34 / build-tools 34.0.0** were downloaded as user-space tarballs
  into `.toolchains/` (gitignored, machine-local, not part of the repo).
- **Gradle 8.9** likewise, used once to generate a proper `gradlew` wrapper
  for the Android project so the *project* doesn't depend on this
  machine-specific path going forward.
- **Tauri's Linux build deps** (webkit2gtk-4.1, gtk3, libsoup3) were already
  present on this machine as system packages — the build was not blocked on
  those. `librsvg2-dev` and `libayatana-appindicator3-dev` were *not*
  present and could not be installed; the app avoids needing them by
  shipping pre-rendered PNG icons (no `tauri icon` codegen step) and not
  using the system-tray feature.

If this machine's toolchain state ever needs reproducing elsewhere, the
`.toolchains/` setup commands are in `docs/BUILD_LOG.md`, not scripted —
worth turning into a real setup script before anyone else needs it.

## No GUI screenshot verification

`DISPLAY=:0` is set and a real desktop session is active on this machine,
but `import` (ImageMagick) failed to capture it (`Resource temporarily
unavailable`) and no `xdotool`/`wmctrl`/other capture tool was available
either. I could confirm the Tauri window process launches, spawns the
sidecar, and the sidecar answers HTTP requests correctly — but I have not
*visually* seen the rendered UI. Please look at it yourself; the CSS is
adapted directly from the architecture-notes artifact's palette, so it
should be visually consistent with that, but "should be" isn't "confirmed."

## No Android emulator, no instrumented tests

The Android SDK was installed with `platform-tools`, `platforms;android-34`,
and `build-tools;34.0.0` only — no system image, no emulator. Test coverage
is JVM unit tests (`app/src/test/`) run via `./gradlew testDebugUnitTest`:
the `FamilyAgentApi` HTTP client against a `MockWebServer`. There is **no
Compose UI test coverage** and the app has never actually run on a device or
emulator — only compiled. Installing an AVD system image (another multi-GB
download) was judged lower priority than getting the desktop app and
agent-core solid within the time available; it's the natural next step if
someone wants to actually run this on a phone or in an emulator before
sideloading it onto a real device.
