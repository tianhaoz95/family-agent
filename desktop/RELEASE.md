# Shipping the macOS desktop app

Direct download, signed with **Developer ID Application** and notarized. The Mac
App Store is not an option: it requires the app sandbox, and the sandbox blocks
spawning the bundled `node`, calling `lsof`, and localhost networking — the three
things `agent-core` runs on.

Team: **HEJI TECHNOLOGY LLC** (`68CTFST8W2`).

---

## Certificates

Both are in the keychain:

```
Developer ID Application: HEJI TECHNOLOGY LLC (68CTFST8W2)   ← distribution
Apple Development: Tianhao Zhou (6522A974B3)                 ← local runs only
```

The scripts prefer the Developer ID one automatically and only fall back to the
development certificate (which cannot be notarized, and which Gatekeeper refuses
on anyone else's Mac) when no Developer ID exists. `FA_MAC_IDENTITY` overrides.

Developer ID certificates last 5 years, you get a limited number, and only the
**Account Holder** can create them. Back the private key up — export it from
Keychain Access as a `.p12` — because losing it means every future release has
to be signed by a different key.

---

## Building and signing

```bash
cd desktop && npm run tauri:build:mac    # CI=true so the DMG step runs headless
cd .. && ./scripts/sign-desktop.sh       # deep-sign + build a signed DMG
./scripts/sign-desktop.sh --notarize     # ...and notarize + staple
./scripts/sign-desktop.sh --verify-only  # report on whatever is signed now
```

`FA_MAC_IDENTITY` overrides identity selection if you have more than one.

### What the signing script does, and why it exists

The bundle ships a whole Node runtime plus native addons under
`Contents/Resources/sidecar` — 9 Mach-O files: the Tauri binary, `node`, and 7
addons/dylibs (onnxruntime ×2 arches, sharp, libvips, `@napi-rs/canvas`).
Tauri signs the `.app`; it does **not** sign loose Mach-O files inside
`Resources`, and an outer signature over unsigned nested code fails both
`codesign --verify --deep --strict` and notarization.

So the script signs innermost-first — dylibs and `.node` addons, then `node`,
then the bundle — with `--options runtime` and a secure timestamp throughout.
`--deep` is deliberately avoided: it would apply the app's entitlements to
nested code, and `node` needs a different set.

**`node` has its own entitlements** (`src-tauri/NodeEntitlements.plist`). It runs
as a child process, so it carries its own signature and entitlements; the app's
do not extend to it. Under the hardened runtime an unentitled `node` dies the
moment V8 allocates executable memory, which looks from the UI like the sidecar
simply never starting.

**One entitlement is stripped, not added.** The official Node.js build ships with
`com.apple.security.get-task-allow` (it permits a debugger to attach), and
Apple's notary service rejects any binary carrying it. The script walks every
Mach-O in the bundle and refuses to build the DMG if it survives — a second here
against a wasted notarization round trip.

**The DMG is rebuilt** from the signed app with `hdiutil` (plus an
`/Applications` symlink for drag-to-install), because Tauri emits the `.app` and
the `.dmg` in one pass and its DMG would otherwise hold the pre-signing copy.

---

## Notarization credentials

**Use an App Store Connect API key, not an app-specific password.** It isn't
tied to anyone's Apple ID password, it can be revoked on its own without
disturbing the account, and the *same key* uploads the iOS build — one
credential covers both platforms.

App Store Connect → **Users and Access** → **Integrations** → App Store Connect
API → generate a **Team Key** with the **Developer** role. The `.p8` downloads
**once** and cannot be fetched again, so file it immediately:

```bash
mkdir -p ~/.appstoreconnect/private_keys
mv ~/Downloads/AuthKey_XXXXXXXXXX.p8 ~/.appstoreconnect/private_keys/
export FA_ASC_KEY_ID=XXXXXXXXXX
export FA_ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

That path matters: `altool` (the iOS upload) finds the key **by id in a
well-known directory**, while `notarytool` (macOS) wants an **explicit path**.
Keeping it there satisfies both, and `scripts/release-ios.sh` looks in the same
place.

Optionally fold it into a keychain profile so nothing needs to be in the
environment at all:

```bash
xcrun notarytool store-credentials FamilyAgent \
  --key ~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8 \
  --key-id XXXXXXXXXX --issuer xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
export FA_NOTARY_PROFILE=FamilyAgent
```

The older route still works if you prefer it: `FA_APPLE_ID` + `FA_APP_PASSWORD`
+ `FA_TEAM_ID`, with an app-specific password from appleid.apple.com →
Sign-In and Security. It's weaker mainly because it's bound to the Apple ID and
has to be reissued if that password changes.

Submission typically takes a few minutes; the script waits, then staples both
the DMG and the `.app` so a copy dragged out of the DMG still validates offline.

---

## Verified so far

Signing has been run end to end, though at the time only the development
certificate existed:

| | |
|---|---|
| All 9 Mach-O binaries signed | inside-out, hardened runtime, secure timestamp |
| `codesign --verify --deep --strict` | clean |
| `flags` | `0x10000(runtime)` — hardened runtime on |
| `TeamIdentifier` | `68CTFST8W2` |
| `get-task-allow` | gone from every binary |
| DMG | 321 MB, signed, mounts, app inside verifies |
| **The app actually runs** | launches under the hardened runtime, spawns the bundled `node`, and `/health` responds |

That last row is the one that matters — the hardened runtime is exactly what
breaks a bundled Node runtime, and it doesn't here.

**Not yet exercised: the notarization submission itself.** Every step up to
`notarytool submit` has run for real, but the script correctly refused to submit
with a development certificate, so no build has been to Apple yet. The first
`release-mac.sh` run will be the first submission, and it is the step most
likely to surface something new. Apple's notary log is specific about what it
rejects.

---

## Auto-update

The app checks for updates on launch and from **Settings → Updates**. It never
installs silently: an update ships the whole app — Node runtime, `agent-core`
and all — and restarting it restarts the server everyone else on the LAN is
talking to. So the user sees the version and decides.

**Endpoint:** `releases/latest/download/latest.json` on this repository. A
release must be published (not a draft, not a pre-release) for clients to see it.

**Two signing systems, don't confuse them.** Apple code signing proves the app
is from you and lets macOS run it. Tauri's updater signature proves an update
came from you and is what the app checks before installing. They are separate
keys with separate jobs.

The updater private key lives at `~/.tauri/family-agent-updater.key` — **outside
the repo, and not recoverable**. Lose it and no already-installed copy will ever
accept another update; every user would have to reinstall by hand. Back it up
somewhere you back up secrets. The public half is in `tauri.conf.json` and is
meant to be committed.

`scripts/sign-desktop.sh --notarize` builds the updater artifact **last**, from
the signed and stapled app. That ordering is the point: `tauri build` emits its
own updater tarball during bundling, long before any code signing has happened,
and shipping that one would push an unsigned app to everybody on the next
update.

### Publishing a release

```bash
./scripts/release-mac.sh --check            # verify the setup, build nothing
./scripts/release-mac.sh --version 1.0.0    # build, sign, notarize, publish
```

`release-mac.sh` does the whole thing: preflight, Tauri build, deep-sign,
notarize and staple, rebuild the DMG and the updater artifact from the signed
app, then create the GitHub release and upload every asset. It uses the `gh`
CLI when that's installed and logged in, and otherwise the REST API with a
token from `FA_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN` (needs
`contents:write`).

**Run `--check` first.** A release build is around twenty minutes, and a missing
credential is a miserable thing to discover at the end of one. It verifies the
certificate, that notarization credentials actually resolve, that the updater
signing key exists, and that GitHub auth is present — then stops.
`--no-upload` stops after notarization; `--draft` uploads without publishing;
`--skip-build` reuses the bundle already on disk.

Two details about how it publishes. The release is created as a **draft**,
assets are uploaded, and only then is it published — `/releases/latest` starts
resolving the moment a release goes public, so publishing first would leave a
window in which an updater fetches a `latest.json` whose tarball hasn't finished
uploading. And afterwards it fetches the two URLs clients actually use and
asserts they return 200, rather than assuming.

The assets it attaches, produced by `scripts/sign-desktop.sh` (still runnable on
its own):

| file | why |
|---|---|
| `Family-Agent-<version>-arm64.dmg` | what people download the first time |
| `Family.Agent.app.tar.gz` (+ `.sig`) | what the updater downloads |
| `latest.json` | the manifest the app polls |

GitHub rewrites spaces in asset names to dots, so `latest.json` points at
`Family.Agent.app.tar.gz`; the tarball is uploaded under exactly that name and
the script asserts the two agree before publishing.

The version comes from `desktop/src-tauri/tauri.conf.json`. Pass `--version
X.Y.Z` to bump it as part of the release; the updater compares against it, so an
unbumped version means installed copies are never offered the update. The script
also refuses to run if the tag already exists on the remote.

### The updater key, and a variable that bites twice

`TAURI_SIGNING_PRIVATE_KEY` holds the key's **contents**;
`TAURI_SIGNING_PRIVATE_KEY_PATH` holds a **path** to it. Two different failures
come out of confusing them:

- A path in the contents variable → `failed to decode base64 secret key`, at the
  *end* of the build, right after notarization has been paid for.
- Only `_PATH` set when running `tauri build` → **`A public key has been found,
  but no private key`**. `tauri build` reads only `TAURI_SIGNING_PRIVATE_KEY`; it
  does not fall back to `_PATH`. This one costs the whole compile.

`release-mac.sh` resolves the key to its contents once, before anything runs, so
both the build and the later signing inherit a form they accept. If you build by
hand, export it yourself:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$(cat ~/.tauri/family-agent-updater.key)"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
```

Preflight signs a throwaway file with the configured key rather than checking a
file exists, so a bad setup surfaces in a second instead of twenty minutes.

One consequence of `createUpdaterArtifacts: true`: `tauri build` emits its own
updater tarball during bundling — from the **unsigned** app, before any signing.
`sign-desktop.sh` deletes it, so the only tarball left to attach is the one built
from the signed and stapled app.

## Known gaps

- **arm64 only.** The build targets the host architecture, so this DMG will not
  run on an Intel Mac. A universal build needs
  `--target universal-apple-darwin` plus a `node` binary and native addons for
  both arches — the bundle already carries x64 onnxruntime, but not x64 sharp,
  canvas, or `node` itself.
- **321 MB.** Inherent to bundling Node plus onnxruntime, transformers and
  tesseract for a local-AI app; noted in `docs/DECISIONS.md` → "macOS desktop
  packaging".
- **Every update is a full 321 MB download.** Tauri has no delta updates, so the
  whole bundle comes down each time. Worth batching changes into fewer releases.
- **Windows** isn't built at all.

## Linux

Linux has no OS code-signing or notarization, so its release runs in CI, not
locally: `.github/workflows/release-linux.yml` fires on `release: published`,
builds the `.deb` + `.AppImage` on a clean Ubuntu runner via
`scripts/release-linux.sh`, and attaches them to the same release the macOS
build created. `workflow_dispatch` re-runs it against any existing tag.

**Auto-update** for Linux needs the Tauri updater key as a repo secret (the
same minisign key `~/.tauri/family-agent-updater.key` the macOS release uses):

```
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/family-agent-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD        # if the key has one
```

Without the secret the workflow still ships installable `.deb`/`.AppImage`
packages — it just skips adding the `linux-x86_64` entry to `latest.json`, so
installed copies don't self-update. `.deb` is never an updater target
regardless (Tauri updates the AppImage only).
