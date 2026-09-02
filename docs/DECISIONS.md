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

## The planner refused to read a number off the family's own document

Reported by the user, and a repeat of a class of failure we'd seen before:
they uploaded `~/Downloads/insurance.pdf`, asked *"what is my insurance
number?"*, and got *"I cannot provide personal information such as insurance
numbers. Please check your family documents for this information."*

This is **not** the FTS retrieval bug from the "three fixes" follow-up in
BUILD_LOG (that was ANDed query tokens — long fixed, and `db.test.ts` proves
the search itself still returns the right document for this exact phrasing).
It's a model-behaviour bug of the same family as "task-agent refused a bare
action phrase": a small model applying a generic "don't disclose personal
data" reflex to a question about the family's *own* paperwork, on their *own*
machine, and answering directly with a refusal instead of delegating to
document-agent.

Fixed defense-in-depth, three layers:

1. **`PLANNER_PROMPT`** — an explicit paragraph that the family's paperwork is
   not PII to be withheld from them, that "detail *out of* a document"
   questions (policy/account/member number, amount, expiry) are document-agent
   requests, and that a refusal or "check your documents yourself" is never an
   acceptable answer for them. Plus a worked example for this exact phrasing
   ("what is my insurance number?").
2. **`DOCUMENT_AGENT_PROMPT`** — when a question asks for a specific value,
   search → `get_document` on the id → read the full text → quote the value
   back; "that's personal information" / "check the document yourself" is
   always wrong once the document is found.
3. **`askFamilyAgent`** — a narrow `LOOKS_LIKE_REFUSAL` regex (privacy-refusal
   shape only; a genuine "I couldn't find an insurance document" must not
   match). A matching reply triggers the one existing retry — the model
   usually delegates on the second attempt — and is kept as the fallback so a
   real (if unhelpful) answer is never downgraded to the generic error.

Verified: fast unit tests in `askFamilyAgent.test.ts` (retry fires on the
verbatim refusal; a genuine not-found answer is left alone; a double refusal
returns the refusal, not the generic error) and a live-model regression test
in `agents.integration.test.ts` ("answers 'what is my insurance number' with
the number, not a privacy refusal").

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

## Multi-user: local accounts + bearer-token sessions

The master node became a real multi-user server. The alternatives considered
and rejected:

- **OS-account integration / PAM.** Ties the app to how one machine is set up,
  doesn't survive the account being reached from a phone, and is far more code
  than the problem needs.
- **No auth, "trust the LAN".** The whole point of the change is that a kid's
  tasks and a parent's medical documents are *separate*. "Same LAN" is not that
  boundary.
- **Passwordless / magic-link / device-pairing.** Nicer onboarding, but needs
  either an email path (there is no cloud here) or a pairing UI on the desktop
  every time; deferred.

What shipped: username + password, hashed with `scrypt` (`auth.ts`,
`N=2^15`, `maxmem` raised above Node's 32 MB default or `scryptSync` throws).
Login returns an opaque random token; only its `sha256` is stored in the
`sessions` table, so a stolen `family-agent.db` can't be replayed. 90-day
sliding expiry. A `preHandler` hook in `server.ts` resolves the token to a
user and attaches `req.userStore` (see below); `/health` + `/auth/*` are the
only public routes. Roles are just `admin` | `member` — admins manage accounts
and machine settings, nothing finer-grained until sharing exists.

## Data isolation via ScopedStore, not a per-user database

Each account's rows live in the same SQLite file with a `user_id` column, and
**every** task/document/activity/tool query goes through `ScopedStore`
(`store.scoped(userId)`), which is the single place that adds `WHERE user_id =
?`. Chosen over one-DB-file-per-user because: the agent tools, extraction, and
inbox watcher already took a `Store`-shaped object, so `ScopedStore` with
identical method names was a near-drop-in; cross-account features (sharing,
later) need one connection anyway; and a forgotten scope shows up as "no rows"
in that user's own view rather than a data leak. A migrated single-user DB
gets `user_id` via `ALTER TABLE ... ADD COLUMN ... DEFAULT '_legacy_'`; the
first admin created during setup calls `reassignLegacyData()` to claim it.

## One planner + one inbox watcher per user

`buildServer` builds a deepagents planner per user id (lazily, cached), each
bound to that user's `ScopedStore`, because a shared planner with a shared
scratch state could mix accounts mid-conversation. `main()` runs one
`chokidar` watcher per account on `<inboxBase>/<userId>` (or the account's
`users.inbox_dir` override), added/removed as accounts are created/deleted via
`server.ts` hooks. The global `config.inboxDir` and its `settings.json` key are
gone; `settings.json` now holds only machine-wide values (`model`,
`ollamaBaseUrl`, `ocrModel`, `serverName`).

## Binding 0.0.0.0, and mDNS discovery

`agent-core` (and the tools server) now bind `0.0.0.0`, not `127.0.0.1`: the
Android app has to reach it from another device, and with bearer-token auth in
front of every route that exposure is the intended design, not a regression.
Discovery is `bonjour-service` (pure-JS mDNS, no native build — consistent
with the `node:sqlite` choice) advertising `_familyagent._tcp`; Android uses
the framework `NsdManager`. `FAMILY_AGENT_MDNS=0` turns advertising off.

**mDNS alone is not enough on the client side.** The Android emulator does
not forward multicast to the host LAN, so `NsdManager` finds nothing there —
and plenty of real home/office Wi-Fi blocks client-to-client mDNS too. So
`ServerDiscovery` runs an **active address probe** alongside mDNS: it sweeps
this device's own /24 (from `NetworkInterface`, no extra permission) plus
`10.0.2.2` (the emulator's alias for the host), hitting `GET /health` on port
4173, and lists anything that answers with `{ ok: true }`. 40-way concurrency,
~600 ms connect timeout, so a dark subnet resolves in a few seconds. On the
emulator the `10.0.2.2` probe is what actually finds the desktop; on a real
phone the /24 sweep covers mDNS-blocked networks. The manual-address field is
still there as a last resort, pre-filled with `10.0.2.2:4173` when running on
an emulator (`ServerDiscovery.isEmulator`).

The tools server (port 4174) is still unauthenticated — it serves a generated
tool's static assets by globally-unique 8-char id, and the id is the
capability. On a family LAN that is an accepted (small) downgrade from the
previous loopback-only bind; revisit if the tool sandbox ever holds anything
sensitive.

## Voice input: Whisper via transformers.js, not the model the user first named

**Requested:** evaluate adding voice input with the local ASR model
`nvidia/nemotron-3.5-asr-streaming-0.6b`.
**Shipped:** speech-to-text via **Whisper** (`Xenova/whisper-base` by default),
run in-process with **transformers.js** (`@huggingface/transformers`, which
pulls `onnxruntime-node`).

Why not the NVIDIA model:

- **It can't ride any inference path this repo has.** Ollama serves LLMs/VLMs
  only — no ASR — so a NeMo model means a *third* runtime. The NeMo
  FastConformer + transducer architecture isn't something llama.cpp or
  whisper.cpp implement either (GGUF is just a container; the runtime still
  needs the graph), and NeMo/Riva proper is a CUDA-and-Docker stack that is
  wildly out of proportion for a family laptop — the same GPU problem the
  `glm-ocr` OCR path already ran into.
- **transformers.js runs Whisper in plain Node on CPU**, with a self-contained
  ONNX runtime, and mirrors the existing OCR story almost exactly: heavy
  dependency, lazy-loaded on first use, model fetched from a CDN once and
  cached under `<dataDir>/` (`asr-models/`, next to `tessdata/`), flagged as
  the one deliberate "leaves the machine" event. Measured: an 11-second clip
  transcribes accurately in ~2.4s on this CPU with the q8 `whisper-base` build.
- If an NVIDIA-lineage model is ever wanted, the realistic route is
  **sherpa-onnx** (runs NeMo transducer/CTC models via ONNX export, has Node
  and Android bindings) — noted, not built.

Other calls made here:

- **It runs in agent-core, not the desktop webview.** transformers.js works in
  the browser too (with WebGPU it'd be faster), but putting it server-side
  means one implementation serves *both* clients — desktop and Android each
  just record a clip and `POST /transcribe`. The Android app would otherwise
  have needed its own on-device ASR.
- **Off the planner, like `extraction.ts`.** A transcript is a mechanical
  pipeline step; the endpoint binds the model directly and returns text. The
  transcript is dropped into the chat composer for the user to review — never
  auto-sent.
- **Clients send WAV, not compressed audio.** The desktop decodes the
  MediaRecorder blob through WebAudio and re-encodes 16 kHz mono PCM16;
  Android's `AudioRecord` produces PCM directly. This keeps
  `agent-core/src/transcribe.ts` a WAV *header parse* with zero audio-codec
  dependency (no ffmpeg).
- **`whisper-base` default, not `tiny.en`.** `tiny.en` is faster but
  English-only; a household may not be. `base` multilingual is a few hundred
  ms slower and still well under the planner turn's latency. Admin-settable
  (`Xenova/whisper-tiny.en` … `whisper-small`) via Settings /
  `FAMILY_AGENT_ASR_MODEL`; not validated against `ollama list` because it's a
  Hugging Face id, not an Ollama model.
- **A stock-phrase filter.** Whisper emits "Thank you." / "you" / "Thanks for
  watching!" on near-silence; a transcript that is *only* one of those is
  dropped so it doesn't land in the chat box.

**Known limitation — Linux desktop mic permission.** The web build and the
macOS/Windows Tauri webviews get `getUserMedia` for free. On Linux, WebKitGTK's
default `permission-request` handler denies media capture; granting it needs a
handler in `desktop/src-tauri/src/main.rs` (via `webview.with_webview(...)` →
`webkit2gtk::WebView::connect_permission_request`). Not added in this pass —
it pulls in a version-pinned `webkit2gtk` dependency that couldn't be verified
in the build environment available, and a wrong version breaks the whole
desktop build. Left as a one-file follow-up; the snippet is in BUILD_LOG.

## Document & task search: SQLite FTS5, not an external search engine

**Context.** Until now both subagents "searched" by enumerating everything —
`list_documents` / `list_tasks` return *every* row and let the model scan the
result. That is fine for a demo and falls over for a real family: hundreds or
thousands of documents don't fit a small local model's context window, and
even when they do, "search quality" degrades to "how well does gemma4:e2b
skim a long list." The user asked for real search.

**What shipped.** In-process full-text search via **SQLite FTS5**, which is
compiled into Node's built-in `node:sqlite` (verified: `CREATE VIRTUAL TABLE
… USING fts5` works with no extension, as do the JSON1 functions and triggers
this relies on). Two standalone FTS5 mirror tables — `documents_fts`
(filename + full text + extracted summary) and `tasks_fts` (title + notes) —
kept in step with the base tables by **AFTER INSERT/UPDATE/DELETE triggers**,
so the index can't drift out of sync with the data no matter which code path
did the write. That's the same principle the activity log already follows
(written inline by every mutating method) — pushed down to the database so
even a future code path that forgets about search stays correct. `user_id`
rides along `UNINDEXED` so a search stays scoped to one family member without
a join. On startup, a row-count mismatch between a base table and its mirror
triggers a full rebuild — this is what backfills the index on the first
upgrade of an existing database, and self-heals any drift; a full rebuild is
milliseconds at family scale. `Store.rebuildSearchIndex()` exposes it for ops.

New surface:
- `ScopedStore.searchDocuments(query, { category?, dueBefore?, dueAfter?, limit? })`
  and `ScopedStore.searchTasks(query, { status?, limit? })`. Ranked by
  `bm25()`, with a `snippet()` excerpt. An empty/unparseable query falls back
  to a recency listing with whatever structured filters were supplied, so
  `searchDocuments("", { category: "bill" })` is "my bills".
- Query tokens are **ORed**, not ANDed. First cut ANDed them ("more words
  narrows"); a live-model test of *"what is my insurance number?"* then found
  nothing — the insurance document never contains the literal word "number",
  so `"insurance" AND "number"` excluded the one document the user wanted.
  ORing and letting `bm25()` rank is the standard search-box behaviour and the
  right call for a small corpus where recall matters more than precision.
- `documents_fts` also indexes the extracted **category**, so "insurance" /
  "bill" / "school" find a document classified that way even when its OCR'd
  text never says the word.
- `search_documents` / `search_tasks` write a `document.searched` /
  `task.searched` row to the activity log (from the tool wrapper, not the
  store method — so the HTTP search endpoints stay silent), giving the
  Activity tab a record of what the agent looked for and how many hits it got.
- Agent tools `search_documents` (bound to document-agent) and `search_tasks`
  (bound to task-agent), plus prompt changes telling both subagents to reach
  for search before the list-everything tools. The planner prompt gained a
  worked example ("do we have the car insurance policy?").
- HTTP: `GET /documents/search` and `GET /tasks/search` (both plain GET, so
  the existing CORS method list already covers them).
- `category` and `importantDates` filters read the extracted-fields JSON on
  the `documents` row directly (`json_extract` / `json_each`) rather than
  being denormalised into columns — the extraction shape is still changing
  and a family corpus is small enough that this is free.

**Why not Meilisearch / Typesense / OpenViking**, even though all three can
run on localhost:
- They'd each be a **second long-running service** to install, version-match,
  supervise (the desktop shell currently spawns exactly one sidecar with a
  `PR_SET_PDEATHSIG` death-pact), health-check, and back up. `node:sqlite`
  was picked specifically to avoid even a native compile step; this would be
  a much bigger dependency.
- They are **secondary stores** that must be kept in sync with SQLite over a
  process boundary — reintroducing exactly the drift problem the triggers
  eliminate, now with partial-write and reconnect failure modes.
- **No row-level security.** `ScopedStore`'s `WHERE user_id = ?` is the one
  isolation boundary; a per-index or per-filter scheme in an external engine
  is a new place for a cross-account leak, in an app that hasn't even built
  cross-account *sharing* yet.
- OpenViking specifically is not a search engine — it's an agent
  context/memory framework (`viking://` virtual FS, its own agent loop). It
  overlaps deepagents' job, needs an embedding model in the ingest path, is
  AGPLv3, and is at v0.3.x. Wrong tool, wrong maturity for a foundational
  dependency.

The tool/HTTP contract is deliberately backend-shaped (`search_documents(query,
filters) -> ranked hits`, then `get_document(id)`), so if a family ever
outgrows FTS5 the backend can change without touching the agent or the
clients. Semantic search (embeddings via Ollama, or `sqlite-vec` — `node:sqlite`
does expose `loadExtension`) is the natural next step behind that same
signature; it's not built here because keyword + structured filters covers
the realistic query set and embeddings add a model to the ingest path.

**Not done: client search UI.** The desktop Documents screen and the Android
app still only *list*. `desktop/src/api.ts` and `android/.../FamilyAgentApi.kt`
gained `searchDocuments` / `searchTasks` client methods (with tests), but no
search box is wired into either UI — that needs a design pass against the two
independent design systems and live-app verification, which is a poor fit for
an unattended session. The agent path — the thing actually asked about — is
complete end to end.

## Warming the model so the first chat isn't slow

The first chat turn after launching was noticeably slower than every turn
after it. Two separate one-time costs, both on Ollama's side:

1. **Model cold-load.** Ollama unloads an idle model after `keep_alive`
   (default 5 min). The next request reloads it — several seconds for
   gemma4:e2b, more on a CPU-only box.
2. **System-prompt prefill.** The planner prompt (~700 tokens) plus the
   deepagents tool schemas get run through the model before the first token.
   Ollama (llama.cpp) caches the KV for a matching prompt *prefix* and reuses
   it on the next request automatically — so this is paid once, then skipped,
   until the slot is evicted.

Nothing to "enable" — prefix caching is already on. Two changes make the
first real turn fast instead:

- **`config.ollamaKeepAlive`** (`OLLAMA_KEEP_ALIVE`, default `"30m"`) is
  passed as `keepAlive` on every `ChatOllama` (`model.ts`). Holds the model
  resident across an interactive session; `"-1"` never unloads (RAM/VRAM
  pinned while idle), `"0"` reverts to unload-immediately.
- **`warmup.ts`** — on startup (and after a model change, via the
  `onModelChange` hook) `main()` fires one throwaway `POST /api/chat` with
  the planner system prompt and `num_predict: 1`. That loads the model and
  primes the prefix KV cache before anyone sends a message. Fire-and-forget
  and fully best-effort: if Ollama isn't up yet or the model is still
  pulling, it logs and moves on — startup never blocks on it, and the first
  turn is just back to being slow.

The warmup uses the planner prompt only. deepagents appends its tool schemas
after it and each subagent has its own system prompt; those tails still
prefill on first use, but they're small next to the base prompt and the
model itself is already resident by then. Warming all four prompts would
just thrash a single KV slot at startup for no real gain.
