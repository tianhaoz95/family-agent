#!/usr/bin/env bash
# Deep-sign the built macOS app, rebuild a signed DMG, and optionally notarize.
#
#   ./scripts/sign-desktop.sh                 # sign the .app and build a signed .dmg
#   ./scripts/sign-desktop.sh --notarize      # ...then notarize and staple
#   ./scripts/sign-desktop.sh --verify-only   # just report on what's already signed
#
# Why this exists rather than tauri.conf.json's `signingIdentity`: the bundle
# ships a whole Node runtime plus native addons (onnxruntime, sharp, canvas) under
# Contents/Resources/sidecar. Tauri signs the .app, not loose Mach-O files inside
# Resources, and an outer signature over unsigned nested code fails both
# `codesign --verify --deep --strict` and notarization. Everything has to be
# signed innermost-first, which is what this does.
#
# Identity:
#   FA_MAC_IDENTITY   full identity string; otherwise a "Developer ID Application"
#                     cert is preferred, falling back to "Apple Development"
#                     (fine for running locally, NOT distributable or notarizable).
#
# Notarization auth, one of:
#   FA_NOTARY_PROFILE                       a `notarytool store-credentials` profile
#   FA_APPLE_ID + FA_APP_PASSWORD + FA_TEAM_ID
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
BUNDLE_DIR="$ROOT/desktop/src-tauri/target/release/bundle"
APP="$BUNDLE_DIR/macos/Family Agent.app"
ENTITLEMENTS="$ROOT/desktop/src-tauri/Entitlements.plist"
NODE_ENTITLEMENTS="$ROOT/desktop/src-tauri/NodeEntitlements.plist"
OUT_DMG="$BUNDLE_DIR/dmg/Family Agent-signed.dmg"

NOTARIZE=0
VERIFY_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --notarize)    NOTARIZE=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    -h|--help)     sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "!! unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -d "$APP" ] || {
  echo "!! no app bundle at:" >&2
  echo "   $APP" >&2
  echo "   build it first:  cd desktop && npm run tauri:build:mac" >&2
  exit 1
}

# ---------------------------------------------------------------- identity

pick_identity() {
  if [ -n "${FA_MAC_IDENTITY:-}" ]; then echo "$FA_MAC_IDENTITY"; return; fi
  local devid
  devid="$(security find-identity -v -p codesigning 2>/dev/null \
            | grep "Developer ID Application" | head -1 \
            | sed 's/.*"\(.*\)".*/\1/')"
  if [ -n "$devid" ]; then echo "$devid"; return; fi
  security find-identity -v -p codesigning 2>/dev/null \
    | grep "Apple Development" | head -1 | sed 's/.*"\(.*\)".*/\1/'
}

IDENTITY="$(pick_identity)"
[ -n "$IDENTITY" ] || {
  echo "!! no code signing identity in the keychain." >&2
  echo "   Xcode > Settings > Accounts > Manage Certificates > + " >&2
  exit 1
}

DISTRIBUTABLE=1
case "$IDENTITY" in
  *"Developer ID Application"*) ;;
  *) DISTRIBUTABLE=0 ;;
esac

echo "==> identity: $IDENTITY"
if [ "$DISTRIBUTABLE" -eq 0 ]; then
  cat <<'EOF'

   !! This is a DEVELOPMENT certificate, not "Developer ID Application".
      The signed app will run on this Mac, but it cannot be notarized and
      Gatekeeper will refuse it on anyone else's machine.

      To fix: Xcode > Settings > Accounts > select the team >
      Manage Certificates > + > Developer ID Application.
      Only the Account Holder of the developer program can create one.

      Continuing so the pipeline can be verified end to end.

EOF
fi

# ------------------------------------------------------------------ verify

report() {
  echo "==> verifying"
  codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | sed 's/^/    /' || true
  echo "==> entitlements on the app"
  codesign -d --entitlements - --xml "$APP" 2>/dev/null \
    | plutil -convert xml1 -o - - 2>/dev/null | grep -E "<key>|<true|<false" | sed 's/^/    /' || true
  echo "==> entitlements on the bundled node"
  codesign -d --entitlements - --xml "$APP/Contents/Resources/sidecar/node" 2>/dev/null \
    | plutil -convert xml1 -o - - 2>/dev/null | grep -E "<key>|<true|<false" | sed 's/^/    /' || true
  echo "==> Gatekeeper assessment"
  spctl -a -vvv -t exec "$APP" 2>&1 | sed 's/^/    /' || true
}

# The notary service rejects any binary carrying get-task-allow (it permits a
# debugger to attach). The official Node.js build ships with it set, so the
# bundled runtime arrives with it and it has to be signed away — catching that
# here costs a second, catching it from a rejection email costs a round trip.
check_get_task_allow() {
  local bad=0 f
  while IFS= read -r f; do
    file -b "$f" 2>/dev/null | grep -q "Mach-O" || continue
    if codesign -d --entitlements - --xml "$f" 2>/dev/null \
         | plutil -convert xml1 -o - - 2>/dev/null \
         | grep -q "get-task-allow"; then
      echo "    !! get-task-allow still set on: ${f#"$APP/"}" >&2
      bad=1
    fi
  done < <(find "$APP" -type f)
  if codesign -d --entitlements - --xml "$APP" 2>/dev/null \
       | plutil -convert xml1 -o - - 2>/dev/null | grep -q "get-task-allow"; then
    echo "    !! get-task-allow still set on the app bundle" >&2
    bad=1
  fi
  return $bad
}

if [ "$VERIFY_ONLY" -eq 1 ]; then report; exit 0; fi

# -------------------------------------------------------------------- sign

# Every Mach-O under Resources, innermost first. --deep is deliberately not used:
# it applies the outer entitlements to nested code, which is wrong here (node
# needs its own set, and the dylibs need none).
echo "==> signing nested binaries"
NESTED=0
while IFS= read -r f; do
  file -b "$f" 2>/dev/null | grep -q "Mach-O" || continue
  [ "$f" = "$APP/Contents/Resources/sidecar/node" ] && continue
  codesign --force --sign "$IDENTITY" --timestamp --options runtime "$f"
  NESTED=$((NESTED + 1))
  echo "    $(basename "$f")"
done < <(find "$APP/Contents/Resources" -type f)
echo "    ($NESTED nested binaries)"

echo "==> signing the bundled node runtime"
codesign --force --sign "$IDENTITY" --timestamp --options runtime \
  --entitlements "$NODE_ENTITLEMENTS" \
  "$APP/Contents/Resources/sidecar/node"

echo "==> signing the app bundle"
codesign --force --sign "$IDENTITY" --timestamp --options runtime \
  --entitlements "$ENTITLEMENTS" \
  "$APP"

report

echo "==> checking for get-task-allow (a notarization blocker)"
if check_get_task_allow; then
  echo "    clean"
else
  echo "!! refusing to continue — see above." >&2
  exit 1
fi

# --------------------------------------------------------------------- dmg

echo "==> building a DMG from the signed app"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
mkdir -p "$(dirname "$OUT_DMG")"
rm -f "$OUT_DMG"
hdiutil create -volname "Family Agent" -srcfolder "$STAGE" \
  -ov -format UDZO "$OUT_DMG" >/dev/null
codesign --force --sign "$IDENTITY" --timestamp "$OUT_DMG"
echo "    $OUT_DMG"

# --------------------------------------------------------------- notarize

if [ "$NOTARIZE" -eq 0 ]; then
  echo
  echo "Signed. To notarize (required before anyone else can open it):"
  echo "  ./scripts/sign-desktop.sh --notarize"
  exit 0
fi

if [ "$DISTRIBUTABLE" -eq 0 ]; then
  echo "!! cannot notarize with a development certificate — see above." >&2
  exit 1
fi

AUTH=()
if [ -n "${FA_NOTARY_PROFILE:-}" ]; then
  AUTH=(--keychain-profile "$FA_NOTARY_PROFILE")
elif [ -n "${FA_APPLE_ID:-}" ] && [ -n "${FA_APP_PASSWORD:-}" ] && [ -n "${FA_TEAM_ID:-}" ]; then
  AUTH=(--apple-id "$FA_APPLE_ID" --password "$FA_APP_PASSWORD" --team-id "$FA_TEAM_ID")
else
  cat >&2 <<'EOF'
!! no notarization credentials. Either store a profile once:

     xcrun notarytool store-credentials FamilyAgent \
       --apple-id you@example.com --team-id 68CTFST8W2 --password <app-specific-password>
     export FA_NOTARY_PROFILE=FamilyAgent

   or set FA_APPLE_ID + FA_APP_PASSWORD + FA_TEAM_ID.
   App-specific passwords come from appleid.apple.com > Sign-In and Security.
EOF
  exit 1
fi

echo "==> submitting to the notary service (this takes a few minutes)"
xcrun notarytool submit "$OUT_DMG" "${AUTH[@]}" --wait

echo "==> stapling"
xcrun stapler staple "$OUT_DMG"
# Staple the app too, so a copy dragged out of the DMG validates offline.
xcrun stapler staple "$APP"

echo "==> final assessment"
spctl -a -vvv -t exec "$APP" 2>&1 | sed 's/^/    /' || true
echo
echo "Done: $OUT_DMG"
