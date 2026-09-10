APP STORE CONNECT SUBMISSION PACK

Everything needed to fill in a listing for the iOS app. Each file maps to one
screen or section in App Store Connect.

  metadata/                the text fields, one per file
    app-name.txt           App Name                          (12/30 chars)
    subtitle.txt           Subtitle                          (28/30)
    promotional-text.txt   Promotional Text                 (165/170)
    keywords.txt           Keywords                          (95/100)
    description.txt        Description                    (2545/4000)
    whats-new.txt          What's New in This Version      (373/4000)
    categories.txt         Category (primary + secondary)
    copyright.txt          Copyright
    urls.txt               Support / Marketing / Privacy Policy URLs

  screenshots/6.9-inch/    six 1320x2868 captures, see the README beside them

  app-privacy.txt              App Privacy questionnaire  -> Data Not Collected
  age-rating.txt               Age Rating questionnaire   -> expect 4+
  export-compliance.txt        Export Compliance
  pricing-and-availability.txt Price tier and territories
  version-information.txt      Version number, build, release option
  app-review-information.txt   Demo account + notes for the reviewer
  testflight.txt               TestFlight, if you go that route instead

CONVENTION: in the text files, everything ABOVE a line containing only "--" is
the literal field value. Below it are notes explaining the choice. Do not paste
the notes.

Verified 2026-09-09: every field is inside its character limit, keywords have no
wasted spaces, and all three URLs return 200.

--------------------------------------------------------------------------------
BEFORE YOU SUBMIT — read app-review-information.txt
--------------------------------------------------------------------------------

This app is a client for a server the user runs at home. A reviewer has no such
server, so the app will sit on the "find a server" screen and be rejected under
Guideline 2.1 (App Completeness). Notes asking a reviewer to install a desktop
app first are not actioned.

There are three ways past that, covered in app-review-information.txt:

  1. Don't ship publicly. TestFlight internal testing needs no App Review at
     all, and none of this folder applies. This was the original plan and it
     remains the honest fit for a household app.
  2. Host one internet-reachable demo server with a real HTTPS certificate and
     put its address and a demo login in the review notes.
  3. Build a "Try a demo" mode into the app, backed by canned local data. About
     a day of work, removes the dependency permanently, and fixes the same dead
     end for ordinary users who install the app before setting up their Mac.

Nothing else in this pack matters until that is decided.

--------------------------------------------------------------------------------
STATE OF THE APP ITSELF
--------------------------------------------------------------------------------

Ready to archive and upload — see ../RELEASE.md.

  Bundle id            app.familyagent.ios
  Team                 68CTFST8W2 (HEJI TECHNOLOGY LLC)
  Version / build      1.1.2, build stamped per upload by scripts/release-ios.sh
  Devices              iPhone only, portrait only
  Privacy manifest     present, ships at the bundle root
  Export compliance    ITSAppUsesNonExemptEncryption = false, already in Info.plist
  Debug hooks          FA_* launch hooks are #if DEBUG, verified absent from Release

Still required in the Apple account before any upload:
  - Register the bundle id under Certificates, Identifiers & Profiles
  - Create the app record in App Store Connect
  - xcode-select must point at Xcode, not CommandLineTools, or xcodebuild is
    unavailable:  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
