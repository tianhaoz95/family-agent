# Shipping the macOS desktop app

Direct download, signed with **Developer ID Application** and notarized. The Mac
App Store is not an option: it requires the app sandbox, and the sandbox blocks
spawning the bundled `node`, calling `lsof`, and localhost networking — the three
things `agent-core` runs on.

Team: **HEJI TECHNOLOGY LLC** (`68CTFST8W2`).

---

## The one thing still missing

This Mac has only an **Apple Development** certificate:

```
Apple Development: Tianhao Zhou (6522A974B3)
  OU=68CTFST8W2  O=HEJI TECHNOLOGY LLC
```

That signs an app that runs *here*. It cannot be notarized, and Gatekeeper
refuses it on anyone else's Mac. You need a **Developer ID Application**
certificate:

> Xcode → Settings → Accounts → select **HEJI TECHNOLOGY LLC** →
> **Manage Certificates** → **+** → **Developer ID Application**

Only the **Account Holder** of the developer program can create one (an Admin
cannot). They last 5 years and you get a limited number, so keep the private key
backed up — export it from Keychain Access as a `.p12`.

Everything else is done and verified. Once the certificate exists,
`scripts/sign-desktop.sh` picks it up automatically — it prefers a Developer ID
identity and only falls back to the development one.

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

Store a keychain profile once:

```bash
xcrun notarytool store-credentials FamilyAgent \
  --apple-id you@example.com \
  --team-id 68CTFST8W2 \
  --password <app-specific-password>
export FA_NOTARY_PROFILE=FamilyAgent
```

Or set `FA_APPLE_ID` + `FA_APP_PASSWORD` + `FA_TEAM_ID` per run. App-specific
passwords come from appleid.apple.com → Sign-In and Security. Submission
typically takes a few minutes; the script waits, then staples both the DMG and
the `.app` so a copy dragged out of the DMG still validates offline.

---

## Verified so far

Run end to end with the development certificate:

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

`spctl -a -t exec` still reports **rejected**, which is correct and expected:
Gatekeeper wants Developer ID *and* notarization. That is the only gap left.

---

## Known gaps

- **arm64 only.** The build targets the host architecture, so this DMG will not
  run on an Intel Mac. A universal build needs
  `--target universal-apple-darwin` plus a `node` binary and native addons for
  both arches — the bundle already carries x64 onnxruntime, but not x64 sharp,
  canvas, or `node` itself.
- **321 MB.** Inherent to bundling Node plus onnxruntime, transformers and
  tesseract for a local-AI app; noted in `docs/DECISIONS.md` → "macOS desktop
  packaging".
- **No auto-update.** Tauri's updater is not configured, so there is no upgrade
  path other than downloading a new DMG.
