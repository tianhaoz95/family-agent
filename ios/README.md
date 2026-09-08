# Family Agent — iOS

Native SwiftUI companion app for a Family Agent home server (`agent-core`). Feature
parity with `android/`; Apple **Liquid Glass** UI on iOS 26 with a
`.ultraThinMaterial` fallback down to **iOS 18**.

It is a pure HTTP client of `agent-core` (same contract as the desktop and Android
apps — types are hand-mirrored in `FamilyAgent/Networking/DTOs.swift`, the way
`android/.../data/ApiModels.kt` mirrors them).

## Layout

```
FamilyAgent.xcodeproj      committed, Xcode 16+ file-system-synchronized groups
                           (project.pbxproj stays tiny; new files auto-add)
Config/                    Info.plist, entitlements (kept out of the synced group)
FamilyAgent/
  App/                     FamilyAgentApp, AppModel (@Observable) + feature extensions
  Networking/              FamilyAgentAPI, DTOs, ServerDiscovery, SettingsStore, Keychain
  DesignSystem/            Theme, Glass (#available shim), Atmosphere, Components, Markdown
  Audio/                   VoiceRecorder (AVAudioEngine -> 16 kHz WAV), AudioPlayer
  Features/<Screen>/       one folder per Android screen
  Resources/               Assets.xcassets, Fonts (Inter + Source Serif, shared with Android)
```

## Build & run

```bash
# resolve the one SPM dependency (swift-markdown-ui); Package.resolved is committed
xcodebuild -resolvePackageDependencies -project FamilyAgent.xcodeproj -scheme FamilyAgent

# build for a simulator
xcodebuild -project FamilyAgent.xcodeproj -scheme FamilyAgent -configuration Debug \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath build build

xcrun simctl boot "iPhone 17 Pro"
xcrun simctl install booted build/Build/Products/Debug-iphonesimulator/FamilyAgent.app
xcrun simctl launch booted app.familyagent.ios
```

The simulator shares the Mac's network, so point discovery / manual entry at
`http://localhost:4173` (or the Mac's LAN IP) when a local `agent-core` is running.

## Notes

- Deployment target **iOS 18.0**. Liquid Glass paths are gated on
  `#available(iOS 26, *)` (`DesignSystem/Glass.swift`); everything below falls
  back to `.ultraThinMaterial`.
- One SPM dependency: `swift-markdown-ui` (the equivalent of Android's
  `multiplatform-markdown-renderer`). Everything else is system frameworks.
- Bundle id `app.familyagent.ios`. Simulator builds are ad-hoc signed; a device
  build needs a `DEVELOPMENT_TEAM`.

## Quick start

```bash
./scripts/start-ios.sh                       # boot a sim, build, install, launch
./scripts/start-ios.sh --login dad:pass --start events   # + DEBUG auto sign-in
```

## Navigation

Chat is the home surface. A drawer slides in over the content (floating
hamburger button top-left, edge-swipe, or scrim tap to dismiss) to switch
between the 12 destinations — the same model as the Android `ModalNavigationDrawer`,
not a master-detail push. Messages → a conversation is the one real push (with a
back button; the menu button hides there).
