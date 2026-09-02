# Decisions made autonomously

This build was done unsupervised (6-hour window, no check-ins) per explicit
instruction. Every place where I deviated from the brainstormed architecture,
or made a call the user didn't specify, is recorded here rather than buried
in commit messages. Read this before trusting any behavior that looks odd.

## Model: what was requested vs. what shipped, and a real mistake in between

**Requested:** "the small gemma 4 e2b," for testing purposes.
**Shipped default (final, correct):** `gemma4:e2b`.

This took two passes to get right, and the middle pass was a genuine mistake
worth being explicit about rather than glossing over.

**Pass 1 (wrong):** I don't have training data past January 2026. Gemma 4 was
released in April 2026 — after my knowledge cutoff — so "gemma 4 e2b" didn't
match anything I recognized, and I silently "corrected" it to gemma3n:e2b (a
real model I did know, from the Gemma 3 line, which also has an E2B variant).
I should have flagged the uncertainty instead of guessing. That substitution
was wrong on its own terms, and it also broke: Ollama rejects gemma3n:e2b for
tool-calling outright —

```
MiddlewareError [ResponseError]: registry.ollama.ai/library/gemma3n:e2b does not support tools
```

I drew the wrong general conclusion from that error — treating it as "this
class of Gemma model doesn't do tool-calling" — and shipped qwen2.5:3b as the
default instead, with docs asserting the substitution was necessary. The user
correctly pushed back on both the model swap and the tool-calling claim.

**What's actually true:** tool-calling support is a property of the specific
model + how Ollama's serving layer templates it, not something deepagents or
LangChain provide or gate. `ChatOllama` just forwards a `tools` field to
Ollama's `/api/chat`; Ollama accepts or rejects it per-model. gemma3n:e2b's
template doesn't support that; gemma4:e2b's does — confirmed by hand, not
assumed, the same way the original rejection was confirmed. Once pulled
(`ollama pull gemma4:e2b`, ~7.2GB) and wired in, it correctly delegated to
subagents and completed multi-step tool-calling tasks in testing (see
BUILD_LOG.md for the transcript).

**Trade-off worth knowing about:** gemma4:e2b is meaningfully slower than
qwen2.5:3b was on this machine's CPU — a full planner turn has taken up to
~110 seconds in testing, vs. a few seconds for qwen2.5:3b. That's the real
cost of using the requested model over a smaller one; test timeouts in this
repo are sized for it (see `test/agents.integration.test.ts`). If snappier
responses matter more than using this exact model, qwen2.5:3b (or another
small tool-calling model) is a one-line `FAMILY_AGENT_MODEL` env var away.

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

## The planner confused "documents" with its own filesystem

`createDeepAgent` bakes in generic `ls`/`read_file`/`write_file`/`edit_file`
tools for the agent's own working-memory filesystem (a deepagents feature,
unrelated to this app's document records). Asked "what documents do I have?"
against a real document that had already been ingested and extracted, the
planner called `ls("/")` on its own empty scratch filesystem, got nothing
back, and confidently told the user there were no documents — never
delegating to document-agent at all. Reproduced identically with both
qwen2.5:3b and gemma4:e2b, so this isn't a model-quality fluke; it's a
genuine naming collision between "documents" (this app's domain concept) and
"files" (deepagents' generic working-memory concept), and small models don't
reliably resolve it from prompt wording alone — a stronger, more explicit
system prompt on its own did not fix it.

What actually fixed it, in combination:

1. **`permissions: [{ operations: ["read", "write"], paths: ["/**"], mode:
   "deny" }]`** on the top-level agent — denies the generic filesystem tools
   any access at all. This didn't stop the planner from *trying* `ls`, but it
   stopped it from getting a plausible-looking (wrong) answer from it.
2. **`middleware: [createFilesystemMiddleware({ tools: ["read_file"] })]`** —
   overrides deepagents' default filesystem middleware to expose only
   `read_file`, removing `ls`/`write_file`/`edit_file` from the tool list
   entirely so the model can't reach for them as an option. (`read_file` has
   to stay — deepagents requires it for internal large-result-recovery
   flows.) This is what actually stopped the wrong tool call.
3. **A worked example in the system prompt** — after step 2, the planner
   stopped calling `ls` but also stopped calling anything, answering "I don't
   have access to a list of your documents" directly. It needed an explicit
   example of the exact `task` tool call (`subagent_type: "document-agent"`,
   a description) for this specific phrasing before it reliably delegated.
   Abstract instructions ("delegate document questions to document-agent")
   were not enough on their own; a concrete example was.

Also added along the way: `document-agent` had no way to *answer* "what
documents do I have" even once reached — its only tools were `get_document`
(needs an id you'd have to already know) and `save_extraction`. Added
`list_documents` (see `agent-core/src/agents/documentTools.ts`).

Verified with 3 repeated runs against gemma4:e2b after all three fixes, plus
a regression test (`agents.integration.test.ts` — "answers 'what documents do
I have' correctly once one exists") that ingests a document, waits for
extraction, and asserts the chat reply actually names it. Worth watching for
this same collision pattern if the tool surface grows — "tasks" vs. some
future generic concept, for instance.

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

PR_SET_PDEATHSIG turned out not to be airtight in practice: under `tauri:dev`,
a Rust rebuild kills and respawns the app binary, and if the old `agent-core`
is slow to exit (or the signal is missed on an abrupt teardown) it gets
reparented to `systemd --user` and keeps holding ports 4173/4174. The fresh
`agent-core` then hit `EADDRINUSE` — and worse, the tools server's raw
`net.Server` had no `error` listener, so that surfaced as an *unhandled* error
event and a hard crash with a stack dump. Three layers were added:

- `agent-core` now retries `EADDRINUSE` on both the API port and the tools
  port for up to 8s (`listenWithRetry` in `tools/server.ts`, and an inline loop
  in `server.ts main()`), which covers the normal rebuild race. If it still
  can't bind it prints one actionable line (`kill $(lsof -ti tcp:4173 ...)`)
  and exits 1 instead of dumping a stack.
- The tools server keeps a permanent `server.on("error")` handler past the
  initial bind so a late socket error can never crash the process.
- `main.rs` reaps stale listeners on startup (`kill_stale_agent_core`,
  Unix-only): `lsof -ti -a -sTCP:LISTEN -itcp:4173 -itcp:4174`, filtered to
  PIDs whose `/proc/<pid>/cmdline` mentions `agent-core`/`server.js`, SIGTERM
  then SIGKILL. It also SIGTERMs (not bare SIGKILLs) the child on shutdown via
  `shutdown_child`, and handles `RunEvent::Exit` in addition to
  `WindowEvent::Destroyed`.

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

## GUI screenshot verification: blocked at the OS level, solved differently

`DISPLAY=:0` is set and a real desktop session is active on this machine,
but every OS-level screen-capture path failed identically —
`import` (ImageMagick), `PIL.ImageGrab`, and GNOME's own screenshot D-Bus
API (`org.gnome.Shell.Screenshot`, `AccessDenied`) all refused to read the
screen. This is a sandbox restriction on this session, not a missing tool.
No `Xvfb` was available either (would need sudo to install), so standing up
an isolated virtual display wasn't an option.

**What worked:** the desktop app's UI is just the HTML/CSS/JS in `desktop/`
rendered inside a WebKitGTK webview — none of that content is
Tauri-specific. Serving `desktop/dist/` (`npx serve`) and opening it in
**headless Chromium via Playwright** renders the exact same DOM/CSS a user
would see in the real Tauri window, and Playwright's screenshot mechanism
works through the browser's own internal compositor, not X11 — no display
server involved at all. Verified the real chat flow end-to-end this way:
typed a message, clicked send, watched the "thinking…" state with the send
button correctly disabled, waited for gemma4:e2b's actual reply, and
confirmed it correctly answered "what's on my task list?" while filtering
out a task that had already been marked done. Also captured Tasks,
Documents (including the live-loaded inbox path from `/health`), and
Activity views against real seeded data.

Caveat worth being precise about: this confirms the *content* renders and
behaves correctly, not the native window chrome (title bar, OS-level
resize handles, tray behavior) Tauri itself adds — that part still hasn't
been seen. Given the content is what almost all of the actual UI/UX
surface is, this closes nearly all of the original gap.

## Android emulator: got real device verification working

Installed the `emulator` package and a
`system-images;android-34;google_apis;x86_64` image (in addition to the
`platform-tools`/`platforms;android-34`/`build-tools;34.0.0` already
present), and created an AVD (`avdmanager create avd`). Hardware
acceleration mattered here: `/dev/kvm` wasn't listed under this user's
group memberships (`groups` doesn't mention `kvm`), which looked like a
dead end — but a direct `os.open('/dev/kvm', O_RDWR)` in Python succeeded,
and `getfacl` confirmed an explicit ACL grant for this user that `groups`
doesn't surface. Worth remembering: **check actual file permissions before
concluding a device is inaccessible from `groups` alone.**

Booted headless (`-no-window -gpu swiftshader_indirect`), installed the
real debug APK, launched it, and used `adb shell screencap` — which reads
the emulator's own framebuffer over the ADB protocol, sidestepping the
host screenshot restriction entirely — to capture all 5 screens. This
caught three real bugs no amount of code review would have found:

1. **Material3's default `NavigationBar` container color** is a tonal
   surface tinted toward the scheme's primary — rendered as an off-palette
   lavender against this app's ledger tones. Fixed by pinning
   `containerColor` and `NavigationBarItemDefaults.colors(...)` explicitly
   to the same tokens the rest of the app uses.
2. The Tasks screen's due-date field (`width(120.dp)`, placeholder
   `"YYYY-MM-DD"`) wrapped its own placeholder onto two lines — too narrow
   for the text at that font size. Widened and shortened the placeholder
   to `"Due date"`.
3. The Documents screen still said "folder watching is future work" —
   true when first written, false by the time this screen actually got
   looked at (folder watching shipped earlier in this same session, just
   on the agent-core/desktop side — the Android copy was never updated to
   match). Same root issue as the dangling doc-path reference caught
   earlier: **a claim about what the app can do needs to be re-checked
   against current reality before shipping, not just checked once when
   written.**

Also surfaced a UI-automation lesson, not a product bug: `adb shell input
tap` coordinates must be real device pixels, not the scaled-down
coordinates a screenshot viewer displays — conflating the two caused
several failed taps before switching to `uiautomator dump` for exact
element bounds. Confirmed genuine cross-device connectivity this way too:
pointed the emulator at the host's agent-core via `10.0.2.2` (the
emulator's standard host-loopback alias), and the Settings screen showed
"Connected · local · gemma4:e2b" for real.

## task-agent refused a bare action phrase ("buy stamps")

Found via the Android round-trip above, not by inspection: "Add a task to
buy stamps" got the reply *"I cannot perform real-world actions like
buying stamps."* — a real conversational bug, reproduced 100% of the time
before the fix. Root cause, found by dumping the raw message trace: the
planner delegated correctly (`task` tool, `subagent_type: "task-agent"`),
but wrote the delegation `description` as just `"buy stamps"` — dropping
the "create a task" framing from the original request. task-agent then
received a bare action phrase with nothing marking it as task-management
input, and reasonably (from its perspective) read it as being asked to
literally buy stamps.

Fixed defense-in-depth on the task-agent side rather than only fixing the
planner's phrasing: `TASK_AGENT_PROMPT` now states explicitly that every
request it receives — even a bare action phrase — means "create/track a
task for this," never "do this in the real world," and that refusing is
always wrong for this subagent. This is more robust than only fixing the
planner's description-writing, since it doesn't depend on the planner
phrasing every future delegation perfectly. Verified consistent across 2
direct runs plus a permanent regression test
(`agents.integration.test.ts` — "creates a task from a bare action phrase
instead of refusing it").

## The retry logic didn't catch every way a small model can misbehave

Found on a later full-suite run, not the same run the bugs above were
found on: the "what documents do I have" test failed with the model's
final reply being literal broken tool-call syntax —
`call:task{description:<|"|>list all ingested documents...<tool_call|>` —
instead of either a clean answer or an empty string. `askFamilyAgent`'s
existing retry (added earlier for empty replies) only checked
`text.trim()`, so a non-empty-but-garbled reply sailed through as if it
were valid. Added a second check, `LOOKS_MALFORMED` (a regex for the
tool-call-syntax fragments actually observed: `<|...|>`, `<tool_call`,
`subagent_type:`, a reply starting with `call:`), treated the same as an
empty reply for retry purposes. Added fast unit-level coverage for the
retry logic itself (`test/askFamilyAgent.test.ts`, a stub agent, no live
model needed) rather than only relying on the live-model test happening to
reproduce this specific garbled shape again — that test only ever
exercises whatever a model happens to do on any given run, which is
exactly what let this slip through once already.
