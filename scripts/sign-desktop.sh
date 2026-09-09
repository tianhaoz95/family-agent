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
# Notarization auth, best first:
#   FA_NOTARY_PROFILE                        a `notarytool store-credentials` profile
#   FA_ASC_ISSUER_ID + one of:
#     FA_KEY_LOCATION      explicit path to the .p8 (key id read off the filename)
#     FA_ASC_KEY_ID        looked up in ~/.appstoreconnect/private_keys/
#   FA_APPLE_ID + FA_APP_PASSWORD + FA_TEAM_ID   app-specific password
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
    -h|--help)     sed -n '2,24p' "$0"; exit 0 ;;
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

# Three ways in, best first. An App Store Connect API key is preferred over an
# app-specific password: it is not tied to anyone's Apple ID password, it can be
# revoked on its own, and the SAME key uploads the iOS build in release-ios.sh.
# Note the two tools disagree on how to find the .p8 — altool looks it up by key
# id in a well-known directory, notarytool wants an explicit path — so keeping it
# at ~/.appstoreconnect/private_keys/AuthKey_<KEY_ID>.p8 satisfies both.
# FA_KEY_LOCATION, if set, is the .p8 itself and wins over the conventional
# locations. The key id can be read back off the filename, so setting it
# separately is optional.
if [ -n "${FA_KEY_LOCATION:-}" ]; then
  ASC_KEY="${FA_KEY_LOCATION/#\~/$HOME}"
  if [ -z "${FA_ASC_KEY_ID:-}" ]; then
    base="$(basename "$ASC_KEY")"; base="${base%.p8}"
    FA_ASC_KEY_ID="${base#AuthKey_}"
  fi
else
  ASC_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_${FA_ASC_KEY_ID:-none}.p8"
  [ -f "$ASC_KEY" ] || ASC_KEY="$HOME/private_keys/AuthKey_${FA_ASC_KEY_ID:-none}.p8"
fi

AUTH=()
if [ -n "${FA_NOTARY_PROFILE:-}" ]; then
  AUTH=(--keychain-profile "$FA_NOTARY_PROFILE")
elif [ -n "${FA_ASC_KEY_ID:-}" ] && [ -n "${FA_ASC_ISSUER_ID:-}" ] && [ -f "$ASC_KEY" ]; then
  AUTH=(--key "$ASC_KEY" --key-id "$FA_ASC_KEY_ID" --issuer "$FA_ASC_ISSUER_ID")
elif [ -n "${FA_APPLE_ID:-}" ] && [ -n "${FA_APP_PASSWORD:-}" ] && [ -n "${FA_TEAM_ID:-}" ]; then
  AUTH=(--apple-id "$FA_APPLE_ID" --password "$FA_APP_PASSWORD" --team-id "$FA_TEAM_ID")
else
  if [ -n "${FA_ASC_KEY_ID:-}" ] && [ ! -f "$ASC_KEY" ]; then
    echo "!! FA_ASC_KEY_ID is set but no key file at:" >&2
    echo "   ~/.appstoreconnect/private_keys/AuthKey_${FA_ASC_KEY_ID}.p8" >&2
    echo >&2
  fi
  cat >&2 <<'EOF'
!! no notarization credentials.

   Recommended — an App Store Connect API key. It is not tied to an Apple ID
   password, is revocable on its own, and the same key uploads the iOS build:

     App Store Connect > Users and Access > Integrations > App Store Connect API
     Generate a Team Key with the Developer role, download the .p8 ONCE, then:

       mkdir -p ~/.appstoreconnect/private_keys
       mv ~/Downloads/AuthKey_XXXXXXXXXX.p8 ~/.appstoreconnect/private_keys/
       export FA_ASC_KEY_ID=XXXXXXXXXX
       export FA_ASC_ISSUER_ID=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx

   Or store either credential in the keychain once and just use the profile:

       xcrun notarytool store-credentials FamilyAgent \
         --key ~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8 \
         --key-id XXXXXXXXXX --issuer xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
       export FA_NOTARY_PROFILE=FamilyAgent

   Or, the older way: FA_APPLE_ID + FA_APP_PASSWORD + FA_TEAM_ID, with an
   app-specific password from appleid.apple.com > Sign-In and Security.
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

# ------------------------------------------------------- updater artifact
#
# Built HERE, from the signed and stapled app — not by `tauri build`. Tauri
# emits its updater tarball during bundling, which is before any of the code
# signing above has happened, so shipping that one would push an unsigned app
# to everybody on the next update. Rebuilding it last is the whole point.

echo "==> building the updater artifact from the signed app"
# `tauri build` also emits an updater tarball, during bundling — i.e. from the
# UNSIGNED app, before any of the work above. Shipping that one would push an
# unsigned app to every installed copy. Delete it so there is only ever one
# candidate to attach to a release.
for stale in "$BUNDLE_DIR/macos/Family Agent.app.tar.gz" "$BUNDLE_DIR/macos/Family Agent.app.tar.gz.sig"; do
  [ -f "$stale" ] && { rm -f "$stale"; echo "    discarded the pre-signing tarball tauri build left in macos/"; }
done
UPDATER_DIR="$BUNDLE_DIR/updater"
mkdir -p "$UPDATER_DIR"
TARBALL="$UPDATER_DIR/Family Agent.app.tar.gz"
rm -f "$TARBALL" "$TARBALL.sig"
# -C so the archive holds "Family Agent.app" at its root, which is what the
# updater expects to swap into place.
#
# COPYFILE_DISABLE=1 is not optional. Without it macOS tar stores every file's
# extended attributes as a parallel AppleDouble member — 13,043 of them for this
# bundle — and the FIRST entry in the archive becomes `._Family Agent.app`.
# Tauri's updater unpacks entries in order, hits that, and dies with
#   failed to unpack `._Family Agent.app`
# after the user has already downloaded 260 MB.
#
# `tar -tzf` will NOT show you these: bsdtar recognises its own Mac metadata and
# hides it while listing. Verify with something that doesn't, e.g.
#   python3 -c "import tarfile;print(sum('._' in n for n in tarfile.open('<f>').getnames()))"
COPYFILE_DISABLE=1 tar --no-mac-metadata -czf "$TARBALL" \
  -C "$(dirname "$APP")" "$(basename "$APP")"

APPLEDOUBLE=$(python3 -c "
import tarfile,sys
print(sum(1 for n in tarfile.open(sys.argv[1]).getnames() if '._' in n))" "$TARBALL")
if [ "$APPLEDOUBLE" != "0" ]; then
  echo "!! the updater tarball still has $APPLEDOUBLE AppleDouble entries — updates would fail" >&2
  exit 1
fi
echo "    no AppleDouble entries"

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  if [ -f "$HOME/.tauri/family-agent-updater.key" ]; then
    # _PATH, not _PRIVATE_KEY: the latter wants the key's *contents*, and handing
    # it a path fails with "failed to decode base64 secret key".
    export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/family-agent-updater.key"
  else
    echo "!! no updater signing key. Expected ~/.tauri/family-agent-updater.key" >&2
    echo "   or TAURI_SIGNING_PRIVATE_KEY / _PATH set. See desktop/RELEASE.md." >&2
    exit 1
  fi
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

( cd "$ROOT/desktop" && npx tauri signer sign "$TARBALL" >/dev/null )
[ -f "$TARBALL.sig" ] || { echo "!! updater signing produced no .sig" >&2; exit 1; }
echo "    $TARBALL"

VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/desktop/src-tauri/tauri.conf.json'))['version'])")"
ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && ARCH="aarch64"
REPO_URL="https://github.com/tianhaoz95/family-agent/releases/download/v$VERSION"

python3 - "$VERSION" "$ARCH" "$REPO_URL" "$TARBALL.sig" "$UPDATER_DIR/latest.json" <<'PY'
import json, sys, datetime, pathlib
version, arch, base, sigfile, out = sys.argv[1:6]
sig = pathlib.Path(sigfile).read_text().strip()
manifest = {
    "version": version,
    "notes": "See the release notes on GitHub.",
    "pub_date": datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z"),
    "platforms": {
        f"darwin-{arch}": {"signature": sig, "url": f"{base}/Family.Agent.app.tar.gz"},
    },
}
pathlib.Path(out).write_text(json.dumps(manifest, indent=2) + "\n")
print(f"    latest.json for darwin-{arch} v{version}")
PY

cat <<EOF

Done.

  DMG      $OUT_DMG
  updater  $TARBALL
           $TARBALL.sig
           $UPDATER_DIR/latest.json

Publish by creating a GitHub release tagged v$VERSION and attaching all three of
the DMG, the .app.tar.gz and latest.json. The updater endpoint points at
releases/latest/download/latest.json, so the release must not be a draft or a
pre-release or clients will not see it.

Note GitHub rewrites spaces in asset names to dots on download, which is why
latest.json points at "Family.Agent.app.tar.gz".
EOF
