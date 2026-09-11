#!/usr/bin/env bash
# Archive the iOS app and export/upload an App Store Connect build.
#
#   ./scripts/release-ios.sh                 # archive + export the .ipa
#   ./scripts/release-ios.sh --upload        # ...and upload it to App Store Connect
#   ./scripts/release-ios.sh --build 7       # set the build number for this upload
#
# Requires (see ios/RELEASE.md):
#   FA_TEAM_ID          your 10-character Apple Developer Team ID
#   Xcode signed in to that team (Xcode > Settings > Accounts), so automatic
#   signing can resolve the distribution certificate and App Store profile.
#
# For --upload, one of:
#   FA_ASC_KEY_ID + FA_ASC_ISSUER_ID    App Store Connect API key. altool finds the
#                                       .p8 by name, not by path — put it in
#                                       ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8
#   FA_APPLE_ID + FA_APP_PASSWORD       app-specific password
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
IOS="$ROOT/ios"
BUILD_DIR="$IOS/build/release"
ARCHIVE="$BUILD_DIR/FamilyAgent.xcarchive"
EXPORT_DIR="$BUILD_DIR/export"

UPLOAD=0
BUILD_NUMBER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --upload) UPLOAD=1; shift ;;
    --build)  BUILD_NUMBER="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "!! unknown argument: $1"; exit 2 ;;
  esac
done

if [ -z "${FA_TEAM_ID:-}" ]; then
  cat >&2 <<'EOF'
!! FA_TEAM_ID is not set.

   It is the 10-character Team ID from developer.apple.com > Membership.
   Without it xcodebuild cannot resolve a distribution signing identity.

     export FA_TEAM_ID=ABCDE12345

   See ios/RELEASE.md for the full first-release checklist.
EOF
  exit 1
fi

command -v xcodebuild >/dev/null || { echo "!! xcodebuild not found — install Xcode" >&2; exit 1; }

# A build number must be unique per version in App Store Connect. Default to a
# UTC timestamp, which is monotonic and never collides.
if [ -z "$BUILD_NUMBER" ]; then
  BUILD_NUMBER="$(date -u +%Y%m%d%H%M)"
fi

MARKETING_VERSION="$(
  grep -m1 'MARKETING_VERSION = ' "$IOS/FamilyAgent.xcodeproj/project.pbxproj" \
    | sed 's/.*MARKETING_VERSION = \(.*\);/\1/'
)"

echo "==> Family Agent $MARKETING_VERSION (build $BUILD_NUMBER)"
echo "    team $FA_TEAM_ID"

rm -rf "$ARCHIVE" "$EXPORT_DIR"
mkdir -p "$BUILD_DIR"

echo "==> resolving package dependencies"
xcodebuild -resolvePackageDependencies \
  -project "$IOS/FamilyAgent.xcodeproj" -scheme FamilyAgent >/dev/null

# CODE_SIGN_STYLE=Automatic below normally resolves the distribution
# certificate + provisioning profile through Xcode's own signed-in account
# (ios/RELEASE.md step 4). Without one signed in — a CI runner, or this
# machine before ever opening Xcode's Accounts pane — xcodebuild can still
# do it non-interactively with -allowProvisioningUpdates and the same App
# Store Connect API key --upload already uses below. Falls back to
# whatever account IS signed into Xcode if the key isn't configured.
SIGNING_AUTH=()
if [ -n "${FA_ASC_KEY_ID:-}" ] && [ -n "${FA_ASC_ISSUER_ID:-}" ]; then
  ASC_KEY_FILE="$HOME/.appstoreconnect/private_keys/AuthKey_${FA_ASC_KEY_ID}.p8"
  [ -f "$ASC_KEY_FILE" ] || ASC_KEY_FILE="$HOME/private_keys/AuthKey_${FA_ASC_KEY_ID}.p8"
  if [ -f "$ASC_KEY_FILE" ]; then
    SIGNING_AUTH=(-allowProvisioningUpdates \
      -authenticationKeyPath "$ASC_KEY_FILE" \
      -authenticationKeyID "$FA_ASC_KEY_ID" \
      -authenticationKeyIssuerID "$FA_ASC_ISSUER_ID")
    echo "    signing         API key $FA_ASC_KEY_ID (no Xcode account needed)"
  fi
fi

echo "==> archiving (Release, generic iOS device)"
xcodebuild archive \
  -project "$IOS/FamilyAgent.xcodeproj" \
  -scheme FamilyAgent \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  "${SIGNING_AUTH[@]}" \
  -archivePath "$ARCHIVE" \
  DEVELOPMENT_TEAM="$FA_TEAM_ID" \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  CODE_SIGN_STYLE=Automatic \
  | grep -E 'error:|warning:|ARCHIVE (FAILED|SUCCEEDED)' || true

[ -d "$ARCHIVE" ] || { echo "!! archive failed" >&2; exit 1; }

# Pre-flight the two things App Store Connect rejects most often, before we
# spend a slow upload finding out.
APP="$ARCHIVE/Products/Applications/FamilyAgent.app"
echo "==> checking the archived bundle"
if [ ! -f "$APP/PrivacyInfo.xcprivacy" ]; then
  echo "!! PrivacyInfo.xcprivacy is missing from the bundle (ITMS-91053)" >&2
  exit 1
fi
echo "    privacy manifest present"
ICON_ALPHA="$(
  python3 - "$IOS/FamilyAgent/Resources/Assets.xcassets/AppIcon.appiconset/icon-1024.png" <<'PY'
import struct, sys
with open(sys.argv[1], "rb") as fh:
    fh.read(8)
    length = struct.unpack(">I", fh.read(4))[0]
    assert fh.read(4) == b"IHDR"
    ihdr = fh.read(length)
    print("yes" if ihdr[9] in (4, 6) else "no")
PY
)"
if [ "$ICON_ALPHA" = "yes" ]; then
  echo "!! the 1024 app icon has an alpha channel — App Store Connect rejects this" >&2
  exit 1
fi
echo "    app icon is opaque"

echo "==> exporting"
EXPORT_PLIST="$BUILD_DIR/ExportOptions.plist"
cp "$IOS/Config/ExportOptions.plist" "$EXPORT_PLIST"
/usr/libexec/PlistBuddy -c "Add :teamID string $FA_TEAM_ID" "$EXPORT_PLIST" 2>/dev/null \
  || /usr/libexec/PlistBuddy -c "Set :teamID $FA_TEAM_ID" "$EXPORT_PLIST"

xcodebuild -exportArchive \
  -archivePath "$ARCHIVE" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_PLIST" \
  "${SIGNING_AUTH[@]}" \
  | grep -E 'error:|EXPORT (FAILED|SUCCEEDED)' || true

IPA="$(find "$EXPORT_DIR" -name '*.ipa' -maxdepth 1 | head -1)"
[ -n "$IPA" ] || { echo "!! no .ipa produced" >&2; exit 1; }
echo "==> $IPA"

if [ "$UPLOAD" -eq 0 ]; then
  cat <<EOF

Archive and .ipa are ready. To upload:

  ./scripts/release-ios.sh --upload --build $BUILD_NUMBER

or open Xcode > Window > Organizer and distribute "$ARCHIVE".
EOF
  exit 0
fi

echo "==> validating with App Store Connect"
AUTH=()
if [ -n "${FA_ASC_KEY_ID:-}" ] && [ -n "${FA_ASC_ISSUER_ID:-}" ]; then
  # altool resolves the key by id from a well-known directory; it takes no path.
  KEY_FILE="$HOME/.appstoreconnect/private_keys/AuthKey_${FA_ASC_KEY_ID}.p8"
  if [ ! -f "$KEY_FILE" ] && [ ! -f "$HOME/private_keys/AuthKey_${FA_ASC_KEY_ID}.p8" ]; then
    echo "!! expected the API key at $KEY_FILE" >&2
    echo "   (altool looks it up by key id, not by path)" >&2
    exit 1
  fi
  AUTH=(--apiKey "$FA_ASC_KEY_ID" --apiIssuer "$FA_ASC_ISSUER_ID")
elif [ -n "${FA_APPLE_ID:-}" ] && [ -n "${FA_APP_PASSWORD:-}" ]; then
  AUTH=(--username "$FA_APPLE_ID" --password "$FA_APP_PASSWORD")
else
  echo "!! no App Store Connect credentials — set FA_ASC_KEY_ID + FA_ASC_ISSUER_ID," >&2
  echo "   or FA_APPLE_ID + FA_APP_PASSWORD. See ios/RELEASE.md." >&2
  exit 1
fi

xcrun altool --validate-app -f "$IPA" -t ios "${AUTH[@]}"
echo "==> uploading"
xcrun altool --upload-app -f "$IPA" -t ios "${AUTH[@]}"
echo "==> done — the build appears in App Store Connect after processing (usually 5-30 min)."
