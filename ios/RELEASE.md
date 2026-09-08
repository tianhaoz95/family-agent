# Shipping Family Agent to the App Store

What's already prepared in this repo, what you have to do by hand in an Apple
account, and the one design problem that decides whether this app can be
reviewed at all.

---

## The blocker to settle first: how does App Review connect?

Family Agent is a client of `agent-core` running on **your** home laptop. A
reviewer in Cupertino opens the app, it scans the LAN, finds nothing, and shows
the "Find your home" screen forever. That is a **Guideline 2.1 — App
Completeness** rejection, and it is the single most likely reason a submission
comes back.

Reviewers do not install a server. Notes in the "App Review Information" box
asking them to set one up will not be actioned. You need one of:

| Option | What it means | Cost |
|---|---|---|
| **Hosted demo server** | Stand up one internet-reachable `agent-core` and put its URL + a demo login in App Review Information. Needs the app to accept a non-LAN `https://` address (it already accepts a manually entered URL — but see ATS below). | A VPS + TLS cert |
| **Demo mode in the app** | A build-visible "Try a demo" path on the discovery screen that runs against canned local data, no server. Reviewable offline, and doubles as a first-run experience. | ~a day of work |
| **Don't ship publicly** | Keep it on **TestFlight internal testing** (up to 100 of your own devices, no App Review at all) or use an **Apple Developer Enterprise / custom app** distribution. | none extra |

If you point the app at a public HTTPS demo server, `NSAllowsLocalNetworking`
is not enough on its own for that host — it only relaxes ATS for local names.
A real `https://` host with a valid certificate passes ATS normally, so a proper
TLS demo server needs no ATS change. Plain `http://` to a public host would
need an ATS exception, which Apple scrutinises; don't go that way.

**For a personal / family app, TestFlight internal testing is the honest answer
and skips this problem entirely.**

---

## Already done in the repo

| | |
|---|---|
| App icon | Regenerated 1024×1024, **opaque, no alpha, full-bleed** (it had an alpha channel and baked-in rounded corners — both rejected/double-masked). `Assets.xcassets/AppIcon.appiconset/icon-1024.png` |
| Privacy manifest | `FamilyAgent/PrivacyInfo.xcprivacy` — required since May 2024, otherwise `ITMS-91053` on upload. Declares no tracking, no collected data, and the one required-reason API the app uses (`UserDefaults`, `CA92.1`). |
| Launch screen | `UILaunchScreen` → `LaunchBackground` colour set (`#F6F5F4`). It previously named an empty colour asset. |
| Version | `MARKETING_VERSION = 1.0.0`; the build number is stamped per upload by the release script. |
| Debug hooks | `FA_SERVER_URL` / `FA_AUTOLOGIN` / `FA_START` / `FA_CHAT_PROMPT` / `FA_DRAWER` are all `#if DEBUG`. Verified absent from the Release binary with `strings`. |
| Usage strings | Microphone, camera, photo library and local network descriptions all present and specific about *why*. |
| Export compliance | `ITSAppUsesNonExemptEncryption = false` — the app itself does no crypto beyond HTTPS/Keychain. Skips the per-upload questionnaire. |
| iPad layout | Content column capped at 700pt so screens read as designed instead of stretching to 1000pt+. |
| Release build | Archives clean at `-O` with `dwarf-with-dsym` and `VALIDATE_PRODUCT = YES`. |

---

## One-time Apple setup (only you can do this)

1. **Apple Developer Program** — $99/year, at <https://developer.apple.com/programs/>.
   A free account can run on your own device but cannot ship to the store.
2. **Team ID** — Membership page, 10 characters. Everything below needs it:
   ```bash
   export FA_TEAM_ID=ABCDE12345
   ```
3. **Register the bundle ID** — Certificates, Identifiers & Profiles → Identifiers
   → `app.familyagent.ios`. No special capabilities are needed; the app uses none.
4. **Sign Xcode into the team** — Xcode → Settings → Accounts. Automatic signing
   then resolves the distribution certificate and App Store profile itself.
5. **Create the app record** in App Store Connect → My Apps → +. Name, primary
   language, the bundle ID from step 3, and an SKU (any private string).

---

## Cutting a build

```bash
export FA_TEAM_ID=ABCDE12345
./scripts/release-ios.sh                      # archive + export the .ipa
./scripts/release-ios.sh --upload             # ...and send it to App Store Connect
./scripts/release-ios.sh --build 7 --upload   # pin the build number
```

The script archives Release for a generic iOS device, checks the two things
App Store Connect rejects most often (missing privacy manifest, icon with an
alpha channel) before spending an upload, exports with
`ios/Config/ExportOptions.plist`, and optionally validates and uploads.

Build numbers default to a UTC timestamp (`202609081432`), which is monotonic
and never collides. `CFBundleVersion` must be unique per `CFBundleShortVersionString`.

For `--upload`, provide either an App Store Connect API key:
```bash
export FA_ASC_KEY_ID=XXXXXXXXXX FA_ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
export FA_ASC_KEY_PATH=~/private_keys/AuthKey_XXXXXXXXXX.p8
```
or an app-specific password (appleid.apple.com → Sign-In and Security):
```bash
export FA_APPLE_ID=you@example.com FA_APP_PASSWORD=abcd-efgh-ijkl-mnop
```

You can also just open Xcode → Window → Organizer and distribute the archive
the script leaves in `ios/build/release/`.

---

## Filling in App Store Connect

**App Privacy.** Answer "**Data Not Collected**". Everything the app sends —
chat, documents, photos, voice — goes to the server the user runs, which you
have no access to; there is no analytics or advertising SDK and no third-party
network call. This must match `PrivacyInfo.xcprivacy`; the two are cross-checked.

**Age rating.** The assistant relays whatever the user's own local model
produces, so treat it as user-generated content when answering the
questionnaire.

**Screenshots.** Required at 6.9" (1320×2868 or 1290×2796). If you keep iPad in
`TARGETED_DEVICE_FAMILY`, 13" iPad shots are required too. Capture them from the
simulator:
```bash
./scripts/start-ios.sh --login user:pass --start chat
xcrun simctl io booted screenshot shot.png
```

**Support URL and privacy policy URL** are both mandatory. A page in the repo's
GitHub Pages or the README will do, but the fields cannot be blank.

**App Review Information** — demo account credentials and, critically, whatever
you settled on at the top of this document.

---

## Known gaps

- **No demo/offline path.** See the blocker above. Nothing else on this list
  matters until that is decided.
- **Landscape is declared but never designed.** `UISupportedInterfaceOrientations`
  allows landscape on iPhone; no screen has been checked in it. Either test it or
  cut it to portrait before submitting.
- **Push notifications.** Routines deliver into the app only — there is no APNs
  integration, so a scheduled routine is invisible until the app is opened. Not a
  blocker, but it is the feature reviewers most often expect from a "reminders"
  app.
- **The icon is derived from a 256px source.** It is now redrawn geometrically at
  1024 so it is crisp, but it is four flat circles; if you want a more considered
  mark, this is the moment.
