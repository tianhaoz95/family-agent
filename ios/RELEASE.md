# Shipping Family Agent

**Route: TestFlight internal testing.** iPhone only, portrait only.

Internal testing needs **no App Review** — you add App Store Connect users as
internal testers (up to 100) and builds go live to them as soon as processing
finishes. That sidesteps the problem that would otherwise sink a public listing:
Family Agent is a client of `agent-core` on your own laptop, so a reviewer in
Cupertino would open it, find nothing on the LAN, and reject under Guideline 2.1
— App Completeness. Nothing here asks a reviewer to set up a server, because
nothing here goes to a reviewer.

You still need the **$99/year Apple Developer Program** — TestFlight is not
available on a free account.

---

## One-time Apple setup (only you can do this)

1. **Apple Developer Program** — <https://developer.apple.com/programs/>.
2. **Team ID** — Membership page, 10 characters. Everything below needs it:
   ```bash
   export FA_TEAM_ID=ABCDE12345
   ```
3. **Register the bundle ID** — Certificates, Identifiers & Profiles →
   Identifiers → `app.familyagent.ios`. No capabilities needed; the app uses none.
4. **Sign Xcode into the team** — Xcode → Settings → Accounts. Automatic signing
   then resolves the distribution certificate and provisioning profile itself.
5. **Create the app record** — App Store Connect → My Apps → **+**. Name, primary
   language, the bundle ID from step 3, any SKU string.

---

## Cutting a build

```bash
export FA_TEAM_ID=ABCDE12345
./scripts/release-ios.sh                      # archive + export the .ipa
./scripts/release-ios.sh --upload             # ...and send it to App Store Connect
./scripts/release-ios.sh --build 7 --upload   # pin the build number
```

The script archives Release for a generic iOS device, pre-flights the two things
App Store Connect rejects most often (a missing privacy manifest, an icon with an
alpha channel) **before** spending a slow upload, exports with
`ios/Config/ExportOptions.plist`, then optionally validates and uploads.

Build numbers default to a UTC timestamp (`202609081432`) — monotonic, never
collides. `CFBundleVersion` must be unique per `CFBundleShortVersionString`.

For `--upload`, use an App Store Connect API key (Users and Access →
Integrations → App Store Connect API → Team Key, **Developer** role). Prefer it
over an app-specific password: it isn't tied to anyone's Apple ID password, it
can be revoked on its own, and the same key also notarizes the macOS build
(`scripts/sign-desktop.sh`).

The `.p8` downloads **once** and can't be fetched again. `altool` looks it up
**by id in a well-known directory** rather than by path, so file it there — which
is also where `notarytool` is pointed from the desktop script:
```bash
mkdir -p ~/.appstoreconnect/private_keys
mv ~/Downloads/AuthKey_XXXXXXXXXX.p8 ~/.appstoreconnect/private_keys/
export FA_ASC_KEY_ID=XXXXXXXXXX FA_ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```
or an app-specific password (appleid.apple.com → Sign-In and Security):
```bash
export FA_APPLE_ID=you@example.com FA_APP_PASSWORD=abcd-efgh-ijkl-mnop
```

Or open Xcode → Window → Organizer and distribute the archive the script leaves
in `ios/build/release/`.

---

## Turning the build on for testers

App Store Connect → your app → **TestFlight**:

1. Wait for the build to finish processing (5–30 min; you get an email).
2. **Internal Testing** → create a group → add people by their App Store Connect
   user (they must be users on your team; add them under Users and Access first).
3. Attach the build to the group. It goes live immediately — no review step.
4. Fill in **What to Test**. This is the only free-text field internal testing
   requires.

Export compliance won't prompt: `ITSAppUsesNonExemptEncryption = false` is
already in `Info.plist`, and it's accurate — the app does no crypto of its own
beyond the system Keychain and TLS.

Testers install the TestFlight app, accept the invite, and need to be on the
same network as your `agent-core` (or reach it over Tailscale/VPN) for the app
to find a server.

---

## Already done in the repo

| | |
|---|---|
| App icon | Regenerated 1024×1024, **opaque, no alpha, full-bleed**. It had an alpha channel — a hard upload rejection — and its own rounded corners, which iOS would have masked a second time. Redrawn geometrically from the same four brand discs rather than upscaled from the 256px logo. |
| Privacy manifest | `FamilyAgent/PrivacyInfo.xcprivacy`. Required for every submission since May 2024; without it the upload fails with `ITMS-91053`. Declares no tracking, no collected data, and the one required-reason API the app uses (`UserDefaults` in `SettingsStore`, reason `CA92.1`). |
| Launch screen | `UILaunchScreen` → `LaunchBackground` colour set (`#F6F5F4`), so there's no white flash before the first frame. It previously named an empty colour asset. |
| Version | `MARKETING_VERSION = 1.1.2`; build number stamped per upload by the script. |
| Device scope | iPhone only (`TARGETED_DEVICE_FAMILY = 1`), portrait only. |
| Debug hooks | `FA_SERVER_URL` / `FA_AUTOLOGIN` / `FA_START` / `FA_CHAT_PROMPT` / `FA_DRAWER` are all `#if DEBUG`, and verified absent from the Release binary with `strings`. |
| Usage strings | Microphone, camera, photo library and local network, each saying *why*. |
| App Transport Security | Off — `NSAllowsArbitraryLoads` only (see the ATS note under "public App Store" below). The app is a plain-http client of a server the user runs; there is no https to require. |
| Release build | Archives clean at `-O`, `dwarf-with-dsym`, `VALIDATE_PRODUCT = YES`, zero warnings. |

---

## If you later go to the public App Store

Three things become blockers that internal TestFlight lets you ignore:

- **Reviewer access.** Either build an in-app demo mode backed by canned data, or
  host one internet-reachable `agent-core` with a valid TLS certificate and put
  its URL plus a demo login in App Review Information. A note asking the reviewer
  to install a server will not be actioned.
- **ATS is off** (`NSAllowsArbitraryLoads = YES`, since 1.1.1). Every connection
  is plain `http://` to a server the user runs on their own machine and points
  the app at by hand — a LAN IP, or a Tailscale `100.x` / MagicDNS address that
  `NSAllowsLocalNetworking` does **not** cover. There is no public host and no
  https to fall back to. A public submission needs this spelled out in App
  Review Information (`store/app-review-information.txt`); it's the same
  rationale VLC / Transmission / other local-server clients use and is routinely
  accepted, but it is a question Apple asks.
- **Store listing.** Screenshots at 6.9" (1320×2868 or 1290×2796), a support URL
  and a privacy policy URL — none of the three can be blank.
- **App Privacy questionnaire.** Answer **Data Not Collected**: everything the app
  sends goes to the server the user runs, which you have no access to, and there
  is no analytics or advertising SDK. It is cross-checked against
  `PrivacyInfo.xcprivacy`, so keep the two in step.

---

## Known gaps

- **No push notifications.** Routines deliver in-app only — there's no APNs
  integration, so a scheduled routine is invisible until someone opens the app.
  Fine for TestFlight; it's the first thing to want on a public release.
- **Landscape is not supported.** Deliberately dropped rather than shipped
  untested. Re-claiming it means actually laying out the drawer and the week
  calendar for it.
- **The icon is four flat discs** derived from a 256px source. Now redrawn crisply
  at 1024, but if you want a more considered mark, do it before people install.
