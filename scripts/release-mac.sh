#!/usr/bin/env bash
# One command from a clean checkout to a published macOS release.
#
#   ./scripts/release-mac.sh                    # build, sign, notarize, publish
#   ./scripts/release-mac.sh --version 1.0.0    # ...bumping the version first
#   ./scripts/release-mac.sh --skip-build       # reuse the bundle already built
#   ./scripts/release-mac.sh --no-upload        # stop after notarization
#   ./scripts/release-mac.sh --draft            # upload but leave the release a draft
#   ./scripts/release-mac.sh --check            # verify the setup and stop
#
# Steps: build the Tauri bundle -> deep-sign every nested binary and the app,
# notarize and staple, rebuild the DMG and the updater artifact from the signed
# app, then create a GitHub release and attach everything.
#
# Signing identity: a "Developer ID Application" certificate in the keychain
# (FA_MAC_IDENTITY overrides). Notarization: see scripts/sign-desktop.sh — this
# script only checks the credentials resolve before spending 20 minutes building.
#
# Publishing needs a GitHub token with contents:write, from any of
# FA_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN, or the `gh` CLI already logged in.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
CONF="$ROOT/desktop/src-tauri/tauri.conf.json"
BUNDLE_DIR="$ROOT/desktop/src-tauri/target/release/bundle"
APP="$BUNDLE_DIR/macos/Family Agent.app"
REPO="tianhaoz95/family-agent"

SKIP_BUILD=0; NO_UPLOAD=0; DRAFT=0; CHECK_ONLY=0; NEW_VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --check)      CHECK_ONLY=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-upload)  NO_UPLOAD=1; shift ;;
    --draft)      DRAFT=1; shift ;;
    --version)    NEW_VERSION="${2:-}"; shift 2 ;;
    -h|--help)    sed -n '2,19p' "$0"; exit 0 ;;
    *) echo "!! unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { echo "!! $*" >&2; exit 1; }

# node comes from nvm on this machine and won't be on PATH in a bare shell.
if ! command -v node >/dev/null 2>&1; then
  # shellcheck disable=SC1090
  [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true
fi
command -v node >/dev/null 2>&1 || die "node not found (nvm not loaded?)"
command -v cargo >/dev/null 2>&1 || { [ -s "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"; }
command -v cargo >/dev/null 2>&1 || die "cargo not found — install Rust"

# ------------------------------------------------------------------ preflight
# Everything that can be known up front is checked up front. A release build is
# ~20 minutes; finding out afterwards that a credential is missing is a waste.

say "preflight"

IDENTITY="${FA_MAC_IDENTITY:-$(security find-identity -v -p codesigning 2>/dev/null \
  | grep "Developer ID Application" | head -1 | sed 's/.*"\(.*\)".*/\1/')}"
[ -n "$IDENTITY" ] || die "no \"Developer ID Application\" certificate in the keychain.
   Xcode > Settings > Accounts > your team > Manage Certificates > + .
   Only the Account Holder can create one."
echo "    identity        $IDENTITY"

# notarization credentials — same resolution order as sign-desktop.sh
if [ -n "${FA_KEY_LOCATION:-}" ]; then
  ASC_KEY="${FA_KEY_LOCATION/#\~/$HOME}"
  ASC_KEY_ID="${FA_ASC_KEY_ID:-}"
  if [ -z "$ASC_KEY_ID" ]; then b="$(basename "$ASC_KEY")"; b="${b%.p8}"; ASC_KEY_ID="${b#AuthKey_}"; fi
else
  ASC_KEY_ID="${FA_ASC_KEY_ID:-}"
  ASC_KEY="$HOME/.appstoreconnect/private_keys/AuthKey_${ASC_KEY_ID:-none}.p8"
  [ -f "$ASC_KEY" ] || ASC_KEY="$HOME/private_keys/AuthKey_${ASC_KEY_ID:-none}.p8"
fi
if [ -n "${FA_NOTARY_PROFILE:-}" ]; then
  echo "    notarization    keychain profile \"$FA_NOTARY_PROFILE\""
elif [ -n "$ASC_KEY_ID" ] && [ -n "${FA_ASC_ISSUER_ID:-}" ] && [ -f "$ASC_KEY" ]; then
  echo "    notarization    API key $ASC_KEY_ID"
elif [ -n "${FA_APPLE_ID:-}" ] && [ -n "${FA_APP_PASSWORD:-}" ] && [ -n "${FA_TEAM_ID:-}" ]; then
  echo "    notarization    app-specific password for $FA_APPLE_ID"
else
  die "no notarization credentials — run ./scripts/sign-desktop.sh --notarize for the setup help."
fi

# Updater signing key. Note the two variables mean different things:
# TAURI_SIGNING_PRIVATE_KEY is the key's *contents*, _PATH is a file path.
# Passing a path in the first one fails with "failed to decode base64 secret key".
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  UPDATER_DESC="TAURI_SIGNING_PRIVATE_KEY (inline)"
elif [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ]; then
  UPDATER_DESC="${TAURI_SIGNING_PRIVATE_KEY_PATH}"
  [ -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ] || die "no updater key at $TAURI_SIGNING_PRIVATE_KEY_PATH"
else
  export TAURI_SIGNING_PRIVATE_KEY_PATH="$HOME/.tauri/family-agent-updater.key"
  UPDATER_DESC="$TAURI_SIGNING_PRIVATE_KEY_PATH"
  [ -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ] || die "no updater signing key at $TAURI_SIGNING_PRIVATE_KEY_PATH.
   Without it the build cannot produce latest.json and installed copies will
   never see this release. See desktop/RELEASE.md."
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# Actually sign something. "The file exists" proves nothing — it did not catch a
# real case of the path being passed in the contents variable, which only fails
# at the very end of a twenty-minute build.
PROBE="$(mktemp -t fa-updater-probe)"; echo probe > "$PROBE"
if ( cd "$ROOT/desktop" && npx tauri signer sign "$PROBE" ) >/dev/null 2>&1 && [ -f "$PROBE.sig" ]; then
  echo "    updater key     $UPDATER_DESC (test signature ok)"
else
  rm -f "$PROBE" "$PROBE.sig"
  die "the updater key is present but signing with it failed.
   If you exported TAURI_SIGNING_PRIVATE_KEY, note it wants the key's CONTENTS;
   use TAURI_SIGNING_PRIVATE_KEY_PATH for a file path. If the key has a
   password, set TAURI_SIGNING_PRIVATE_KEY_PASSWORD."
fi
rm -f "$PROBE" "$PROBE.sig"

# github token (unless we're not publishing)
TOKEN="${FA_GITHUB_TOKEN:-${GH_TOKEN:-${GITHUB_TOKEN:-}}}"
USE_GH=0
if [ "$NO_UPLOAD" -eq 0 ] && [ "$CHECK_ONLY" -eq 0 ]; then
  if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    USE_GH=1; echo "    publishing      gh CLI"
  elif [ -n "$TOKEN" ]; then
    echo "    publishing      REST API with a token"
  else
    die "no GitHub credentials. Either \`gh auth login\`, or set FA_GITHUB_TOKEN
   to a token with contents:write. Use --no-upload to stop after notarizing."
  fi
fi

# ------------------------------------------------------------------- version

if [ -n "$NEW_VERSION" ]; then
  echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "--version must be X.Y.Z"
  python3 - "$CONF" "$NEW_VERSION" <<'PY'
import json, sys, collections
p, v = sys.argv[1], sys.argv[2]
d = json.load(open(p), object_pairs_hook=collections.OrderedDict)
d["version"] = v
json.dump(d, open(p, "w"), indent=2); open(p, "a").write("\n")
PY
  echo "    version set to  $NEW_VERSION"
fi
VERSION="$(python3 -c "import json;print(json.load(open('$CONF'))['version'])")"
TAG="v$VERSION"
echo "    version         $VERSION  (tag $TAG)"

if [ "$CHECK_ONLY" -eq 1 ]; then
  if [ "$NO_UPLOAD" -eq 0 ]; then
    if command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
      echo "    publishing      gh CLI"
    elif [ -n "$TOKEN" ]; then
      echo "    publishing      REST API with a token"
    else
      echo "    publishing      !! no GitHub credentials yet (gh CLI or FA_GITHUB_TOKEN)"
    fi
  fi
  say "setup looks good — run without --check to build and release"
  exit 0
fi

if [ "$NO_UPLOAD" -eq 0 ]; then
  # A tag that already exists means this version already shipped; bump instead of
  # quietly producing a second release for the same version.
  if git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q "$TAG"; then
    die "tag $TAG already exists on origin. Bump with --version X.Y.Z."
  fi
  [ -z "$(git status --porcelain)" ] || echo "    !! working tree is dirty; the release will point at the last commit"
fi

# --------------------------------------------------------------------- build

if [ "$SKIP_BUILD" -eq 0 ]; then
  say "building (this takes a while — Rust release + the bundled sidecar)"
  ( cd "$ROOT/desktop" && CI=true npm run tauri:build:mac )
else
  say "skipping build"
  [ -d "$APP" ] || die "no bundle at $APP — drop --skip-build"
fi
[ -d "$APP" ] || die "the build produced no app bundle"

# ------------------------------------------------------- sign + notarize

say "signing, notarizing and building the updater artifact"
"$ROOT/scripts/sign-desktop.sh" --notarize

DMG="$BUNDLE_DIR/dmg/Family Agent-signed.dmg"
TARBALL="$BUNDLE_DIR/updater/Family Agent.app.tar.gz"
MANIFEST="$BUNDLE_DIR/updater/latest.json"
for f in "$DMG" "$TARBALL" "$TARBALL.sig" "$MANIFEST"; do
  [ -f "$f" ] || die "expected artifact missing: $f"
done

# The manifest must point at the asset name GitHub will actually serve. GitHub
# rewrites spaces to dots, so the tarball is uploaded under a dotted name and
# latest.json is generated to match — assert that rather than trust it.
grep -q "Family.Agent.app.tar.gz" "$MANIFEST" \
  || die "latest.json does not reference Family.Agent.app.tar.gz — the updater would 404"

if [ "$NO_UPLOAD" -eq 1 ]; then
  say "done (not published)"
  printf '  %s\n' "$DMG" "$TARBALL" "$TARBALL.sig" "$MANIFEST"
  exit 0
fi

# ------------------------------------------------------------------ publish

DMG_NAME="Family-Agent-$VERSION-arm64.dmg"
NOTES="Family Agent $VERSION

Signed with Developer ID and notarized by Apple. Download the .dmg, drag the app
to Applications, and open it.

Installed copies update themselves from here — the .app.tar.gz and latest.json
are for the auto-updater and are not something to download by hand."

say "publishing $TAG"

if [ "$USE_GH" -eq 1 ]; then
  DRAFT_FLAG=(--draft)
  gh release create "$TAG" --repo "$REPO" --title "Family Agent $VERSION" \
    --notes "$NOTES" "${DRAFT_FLAG[@]}"
  gh release upload "$TAG" --repo "$REPO" \
    "$DMG#$DMG_NAME" \
    "$TARBALL#Family.Agent.app.tar.gz" \
    "$TARBALL.sig#Family.Agent.app.tar.gz.sig" \
    "$MANIFEST#latest.json"
  if [ "$DRAFT" -eq 0 ]; then gh release edit "$TAG" --repo "$REPO" --draft=false; fi
else
  api() { curl -sS -H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json" "$@"; }

  # Created as a draft first, so /releases/latest never points at a release whose
  # assets are still uploading — an updater polling mid-upload would 404.
  CREATE=$(api -X POST "https://api.github.com/repos/$REPO/releases" \
    -d "$(python3 -c "
import json,sys
print(json.dumps({'tag_name':sys.argv[1],'name':'Family Agent '+sys.argv[2],
                  'body':sys.argv[3],'draft':True,'prerelease':False}))" "$TAG" "$VERSION" "$NOTES")")
  REL_ID=$(echo "$CREATE" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('id') or '')")
  [ -n "$REL_ID" ] || { echo "$CREATE" | head -20 >&2; die "could not create the release"; }
  echo "    draft release $REL_ID"

  upload() {
    local file="$1" name="$2" type="$3"
    echo "    uploading $name ($(du -h "$file" | cut -f1))"
    local out
    out=$(curl -sS -X POST \
      -H "Authorization: Bearer $TOKEN" \
      -H "Content-Type: $type" \
      --data-binary @"$file" \
      "https://uploads.github.com/repos/$REPO/releases/$REL_ID/assets?name=$name")
    echo "$out" | python3 -c "
import sys,json
d=json.load(sys.stdin)
if d.get('state')!='uploaded': print('    !! upload failed:', json.dumps(d)[:300]); sys.exit(1)"
  }
  upload "$DMG"          "$DMG_NAME"                     "application/x-apple-diskimage"
  upload "$TARBALL"      "Family.Agent.app.tar.gz"       "application/gzip"
  upload "$TARBALL.sig"  "Family.Agent.app.tar.gz.sig"   "text/plain"
  upload "$MANIFEST"     "latest.json"                   "application/json"

  if [ "$DRAFT" -eq 0 ]; then
    api -X PATCH "https://api.github.com/repos/$REPO/releases/$REL_ID" -d '{"draft":false}' >/dev/null
    echo "    published"
  fi
fi

# ------------------------------------------------------------------- verify

if [ "$DRAFT" -eq 0 ]; then
  say "verifying what clients will actually fetch"
  sleep 4
  for u in "https://github.com/$REPO/releases/latest/download/latest.json" \
           "https://github.com/$REPO/releases/latest/download/Family.Agent.app.tar.gz"; do
    code=$(curl -s -o /dev/null -w '%{http_code}' -L "$u")
    printf '    %s  %s\n' "$code" "$u"
    [ "$code" = "200" ] || echo "    !! expected 200 — the updater relies on this URL"
  done
fi

cat <<EOF

Released $TAG.

  https://github.com/$REPO/releases/tag/$TAG

If this is the first release, flip the landing page CTAs back to the download
link — site/index.html has a comment marking exactly what to change.
EOF
