#!/usr/bin/env bash
# Build, sign, notarize and attach the macOS bundle to an existing GitHub
# release. The CI counterpart of scripts/release-mac.sh — that script is a
# one-command "build AND create the release" tool for running by hand; this
# one only *attaches* to a release that already exists (scripts/cut-release.sh
# creates it), same division of labor as scripts/release-{linux,windows}.sh.
# Driven by .github/workflows/release-mac.yml on `release: published`, or by
# hand on a Mac with the signing identity + notarization credentials already
# set up (see scripts/sign-desktop.sh's header for exactly what those are).
#
#   ./scripts/release-mac-ci.sh                 # attach to the latest release
#   ./scripts/release-mac-ci.sh --tag v1.3.0    # a specific tag
#   ./scripts/release-mac-ci.sh --skip-build    # reuse an existing bundle
#   ./scripts/release-mac-ci.sh --no-upload     # build+sign+notarize, print the artifacts
#
# Unlike Linux/Windows, there is no "unsigned" fallback here: an unsigned or
# un-notarized .app is useless to distribute (Gatekeeper refuses it on
# anyone else's Mac), so a missing identity or notarization credential is a
# hard failure, not a degraded build.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
CONF="$ROOT/desktop/src-tauri/tauri.conf.json"
BUNDLE_DIR="$ROOT/desktop/src-tauri/target/release/bundle"
APP="$BUNDLE_DIR/macos/Family Agent.app"
REPO="tianhaoz95/family-agent"

TAG=""; SKIP_BUILD=0; NO_UPLOAD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)        TAG="${2:-}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-upload)  NO_UPLOAD=1; shift ;;
    -h|--help)    sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "!! unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { echo "!! $*" >&2; exit 1; }

command -v node  >/dev/null 2>&1 || die "node not found"
command -v cargo >/dev/null 2>&1 || { [ -s "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"; }
command -v cargo >/dev/null 2>&1 || die "cargo not found — install Rust"

GH_ENV_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-${FA_GITHUB_TOKEN:-}}}"
if [ "$NO_UPLOAD" -eq 0 ]; then
  command -v gh >/dev/null 2>&1 || die "gh CLI not found (needed to upload; use --no-upload to skip)"
  gh auth status >/dev/null 2>&1 || [ -n "$GH_ENV_TOKEN" ] || die "not logged in to gh and no GH_TOKEN set"
fi

# ------------------------------------------------------------------ preflight

say "preflight"

IDENTITY="${FA_MAC_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/')}"
[ -n "$IDENTITY" ] || die "no \"Developer ID Application\" certificate in the keychain (import it first — see .github/workflows/release-mac.yml)."
echo "    identity        $IDENTITY"

if [ -n "${FA_NOTARY_PROFILE:-}" ]; then
  echo "    notarization    keychain profile \"$FA_NOTARY_PROFILE\""
elif [ -n "${FA_ASC_KEY_ID:-}" ] && [ -n "${FA_ASC_ISSUER_ID:-}" ] && [ -n "${FA_KEY_LOCATION:-}" ] && [ -f "${FA_KEY_LOCATION/#\~/$HOME}" ]; then
  echo "    notarization    API key $FA_ASC_KEY_ID"
elif [ -n "${FA_APPLE_ID:-}" ] && [ -n "${FA_APP_PASSWORD:-}" ] && [ -n "${FA_TEAM_ID:-}" ]; then
  echo "    notarization    app-specific password for $FA_APPLE_ID"
else
  die "no notarization credentials (FA_ASC_KEY_ID/_ISSUER_ID/FA_KEY_LOCATION, or FA_NOTARY_PROFILE, or FA_APPLE_ID/_APP_PASSWORD/_TEAM_ID)."
fi

if [ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  if [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ] && [ -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]; then
    TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")"
    export TAURI_SIGNING_PRIVATE_KEY
  else
    die "no updater signing key (TAURI_SIGNING_PRIVATE_KEY or _PATH)."
  fi
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"
echo "    updater key     present"

VERSION="$(node -e "console.log(require('$CONF').version)")"
if [ -z "$TAG" ] && [ "$NO_UPLOAD" -eq 0 ]; then
  TAG="$(gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null || true)"
fi
[ -n "$TAG" ] || TAG="v$VERSION"
echo "    version         $VERSION"
echo "    release tag     $TAG"
if [ "$TAG" != "v$VERSION" ]; then
  echo "    !! tauri.conf.json is $VERSION but the tag is $TAG — check out the tagged commit first"
fi

# --------------------------------------------------------------------- build

if [ "$SKIP_BUILD" -eq 0 ]; then
  say "building (Rust release + the bundled sidecar — a few minutes)"
  ( cd "$ROOT/desktop" && CI=true npm run tauri:build:mac )
else
  say "skipping build"
fi
[ -d "$APP" ] || die "no app bundle at: $APP"

# ------------------------------------------------------- sign + notarize

say "signing, notarizing and building the updater artifact"
"$ROOT/scripts/sign-desktop.sh" --notarize

DMG="$BUNDLE_DIR/dmg/Family Agent-signed.dmg"
TARBALL="$BUNDLE_DIR/updater/Family Agent.app.tar.gz"
MANIFEST="$BUNDLE_DIR/updater/latest.json"
for f in "$DMG" "$TARBALL" "$TARBALL.sig" "$MANIFEST"; do
  [ -f "$f" ] || die "expected artifact missing: $f"
done

if [ "$NO_UPLOAD" -eq 1 ]; then
  say "done (not uploaded)"
  printf '  %s\n' "$DMG" "$TARBALL" "$TARBALL.sig" "$MANIFEST"
  exit 0
fi

# --------------------------------------------------------------- publish

DMG_NAME="Family-Agent-$VERSION-arm64.dmg"

say "attaching to $TAG"
[ -z "$GH_ENV_TOKEN" ] || export GH_TOKEN="$GH_ENV_TOKEN"

gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 \
  || die "release $TAG does not exist yet — run scripts/cut-release.sh first"

gh release upload "$TAG" --repo "$REPO" --clobber \
  "$DMG#$DMG_NAME" \
  "$TARBALL#Family.Agent.app.tar.gz" \
  "$TARBALL.sig#Family.Agent.app.tar.gz.sig"

# Patch latest.json to add this platform's entry. Another platform's build
# may have already written it, or none may have yet (mac, linux and windows
# all attach independently now — see cut-release.sh) — merge in, don't
# replace, and start fresh if it's not there yet.
ARCH="$(uname -m)"; [ "$ARCH" = "arm64" ] && ARCH="aarch64"
say "adding darwin-$ARCH to latest.json"
TMP="$(mktemp -d)"
gh release download "$TAG" --repo "$REPO" --pattern latest.json --dir "$TMP" --clobber 2>/dev/null || {
  echo "    no latest.json on $TAG yet (first platform to publish) — starting fresh"
  node -e '
    const fs = require("fs");
    fs.writeFileSync(process.argv[1], JSON.stringify({
      version: process.argv[2],
      notes: "See the release notes on GitHub.",
      pub_date: new Date().toISOString(),
      platforms: {},
    }, null, 2) + "\n");
  ' "$TMP/latest.json" "$VERSION"
}

node -e '
  const fs = require("fs");
  const [, , manifestPath, ourManifestPath, arch] = process.argv;
  const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const ours = JSON.parse(fs.readFileSync(ourManifestPath, "utf8"));
  m.platforms ??= {};
  m.platforms[`darwin-${arch}`] = ours.platforms[`darwin-${arch}`];
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + "\n");
  console.log("    platforms now:", Object.keys(m.platforms).join(", "));
' "$TMP/latest.json" "$MANIFEST" "$ARCH"

gh release upload "$TAG" --repo "$REPO" --clobber "$TMP/latest.json#latest.json"
rm -rf "$TMP"

# ------------------------------------------------------------------- verify

say "verifying what a macOS client will fetch"
fetchable() {
  local url="$1" tries=8 code
  while [ "$tries" -gt 0 ]; do
    code="$(curl -s -o /dev/null -w '%{http_code}' -L "$url")"
    [ "$code" = "200" ] && { echo "$code"; return 0; }
    tries=$((tries - 1))
    sleep 3
  done
  echo "$code"
  return 1
}
for asset in "$DMG_NAME" "Family.Agent.app.tar.gz"; do
  code="$(fetchable "https://github.com/$REPO/releases/download/$TAG/$asset")" || die "$asset is not fetchable (got $code)"
  printf '    %s  %s\n' "$code" "$asset"
done
curl -s -L "https://github.com/$REPO/releases/latest/download/latest.json" \
  | node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8')); if(!d.platforms['darwin-$ARCH']) throw new Error(JSON.stringify(d.platforms)); console.log('    latest.json carries darwin-$ARCH ✓')"

cat <<EOF

Attached the macOS build to $TAG.

  https://github.com/$REPO/releases/tag/$TAG
EOF
