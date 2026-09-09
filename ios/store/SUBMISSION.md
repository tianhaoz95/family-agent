# App Store Connect submission package — Family Agent iOS

Everything you paste into App Store Connect, one file per screen. `../RELEASE.md`
is the *how to build and upload*; this folder is the *what to type in the boxes*.

`../RELEASE.md` recommends the **TestFlight internal** route (no App Review, no
demo-server problem). This package covers that **and** a full public submission,
because a public listing needs almost all the same fields plus a few blockers.

---

## Files

| File | App Store Connect location |
|---|---|
| `metadata/app-name.txt` | App Information → Name |
| `metadata/subtitle.txt` | version page → Subtitle |
| `metadata/promotional-text.txt` | version page → Promotional Text |
| `metadata/description.txt` | version page → Description |
| `metadata/keywords.txt` | version page → Keywords |
| `metadata/whats-new.txt` | version page → What's New in This Version |
| `metadata/categories.txt` | App Information → Category (Primary/Secondary) |
| `metadata/copyright.txt` | App Information → Copyright |
| `metadata/urls.txt` | version page → Support URL / Marketing URL |
| `screenshots/6.9-inch/*.png` | version page → App Previews and Screenshots (6.9") |
| `screenshots/README.md` | upload order, captions, **a recapture to do** |
| `app-privacy.txt` | App Privacy (app-level) + Privacy Policy URL |
| `age-rating.txt` | version page → Age Rating questionnaire |
| `app-review-information.txt` | version page → App Review Information |
| `export-compliance.txt` | asked at build submission (won't prompt — plist set) |
| `pricing-and-availability.txt` | Pricing and Availability + Content Rights |
| `version-information.txt` | every remaining field on the version page, consolidated |
| `testflight.txt` | TestFlight → Test Information + What to Test |

---

## Facts about this build (already in the repo)

| | |
|---|---|
| Bundle ID | `app.familyagent.ios` |
| Apple Team | `68CTFST8W2` (`DEVELOPMENT_TEAM` in `project.pbxproj`) |
| Version | `1.0.0` (`MARKETING_VERSION`) |
| Build number | stamped per upload by `scripts/release-ios.sh` (UTC timestamp) |
| Device family | iPhone only, portrait only |
| Min iOS | 18.0 |
| Encryption | `ITSAppUsesNonExemptEncryption = false` — no export-compliance prompt |
| Privacy manifest | `FamilyAgent/PrivacyInfo.xcprivacy` — no tracking, no data collected |
| Data collection | **None.** App Privacy answer is "Data Not Collected". |
| Price | Free, no IAP, no subscriptions |
| Localisation | English (U.S.) only |
| Copyright | `2026 HEJI TECHNOLOGY LLC` |

---

## Known blockers for a PUBLIC submission (TestFlight-internal ignores all three)

1. **Reviewer needs a reachable server.** Family Agent is useless without an
   `agent-core` to connect to. Stand up one internet-facing instance with real
   HTTPS + a `reviewer` demo account and put it in `app-review-information.txt`,
   or expect a Guideline 2.1 rejection. Detail in that file.

2. **User-generated content safeguards.** The Messages tab + shared board are
   user-to-user content with no in-app report / block / moderation contact
   (Guideline 1.2). Options: add those controls, ship 1.0 without Messages, or
   stay on TestFlight internal. Detail in `age-rating.txt`.

3. **Account-deletion path (Guideline 5.1.1(v)).** Accounts live on the
   self-hosted server; confirm the in-app Settings screen tells the user how an
   admin removes an account and how to wipe the server's data dir. The privacy
   policy already documents it. Detail in `pricing-and-availability.txt`.

---

## Order of operations

### One-time (see `../RELEASE.md` for the detail)
1. Apple Developer Program membership, Team ID.
2. Register bundle ID `app.familyagent.ios` (no capabilities).
3. App Store Connect → My Apps → **+** → create the app record with
   `metadata/app-name.txt`, primary language English (U.S.), the bundle ID, a SKU.
4. Fill **App Information**: subtitle, category (`metadata/categories.txt`),
   copyright (`metadata/copyright.txt`), Content Rights (No),
   Privacy Policy URL (`app-privacy.txt`).
5. Complete **App Privacy** → "Data Not Collected" (`app-privacy.txt`).

### Per release
6. `export FA_TEAM_ID=68CTFST8W2` then `./scripts/release-ios.sh --upload`
   (needs the App Store Connect API key filed under
   `~/.appstoreconnect/private_keys/` — see `../RELEASE.md`).
7. Wait for processing (email, ~5-30 min).

### TestFlight internal (recommended)
8. TestFlight → Test Information (`testflight.txt`).
9. Internal Testing group → add team users → attach build → set **What to Test**
   (`testflight.txt`). Live immediately, no review.

### …or public App Store
8. Version page: paste subtitle, promotional text, description, keywords,
   what's new, URLs (`version-information.txt`).
9. Upload the six 6.9" screenshots — **recapture `board.png` first**
   (`screenshots/README.md`).
10. Age Rating questionnaire (`age-rating.txt`).
11. App Review Information — contact + **demo server** + notes
    (`app-review-information.txt`).
12. Pricing and Availability — Free, all regions
    (`pricing-and-availability.txt`).
13. Resolve the three blockers above.
14. Attach the build, "Manually release this version", Submit for Review.

---

## Placeholders you must fill before submitting

- `app-review-information.txt`: your name, phone, the demo server URL + password.
- `testflight.txt` (external testers only): same.
- `version-information.txt`: SKU string (any stable value).
- Confirm `app.familyagent.ios` is registered and the App Store name
  "Family Agent" is available (it may already be taken — check at app-record
  creation).
