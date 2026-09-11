#!/usr/bin/env bash
# Build the Linux desktop bundles (.deb + .AppImage) and attach them to an
# existing GitHub release. The Linux counterpart of scripts/release-mac.sh — but
# much simpler, because Linux has no OS code-signing or notarization step:
#
#   • no `codesign`, `notarytool`, `stapler`, `spctl` — an unsigned .deb /
#     .AppImage installs and runs, nothing in the OS blocks it;
#   • the ONLY signature is Tauri's own updater minisign, and only when
#     TAURI_SIGNING_PRIVATE_KEY is set. Without it the .deb/.AppImage still
#     ship — they just don't get an auto-update entry in latest.json.
#
#   ./scripts/release-linux.sh                 # attach to the latest release
#   ./scripts/release-linux.sh --tag v1.3.0    # a specific tag
#   ./scripts/release-linux.sh --skip-build    # reuse an existing bundle
#   ./scripts/release-linux.sh --no-upload     # build only, print the artifacts
#
# The macOS release (scripts/release-mac.sh) creates the tag + the GitHub
# release and its latest.json. This script only *adds* the Linux assets, so it
# runs after — driven by .github/workflows/release-linux.yml on
# `release: published`, or by hand on a Linux box.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
CONF="$ROOT/desktop/src-tauri/tauri.conf.json"
BUNDLE_DIR="$ROOT/desktop/src-tauri/target/release/bundle"
REPO="tianhaoz95/family-agent"

TAG=""; SKIP_BUILD=0; NO_UPLOAD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)        TAG="${2:-}"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --no-upload)  NO_UPLOAD=1; shift ;;
    -h|--help)    sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "!! unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { echo "!! $*" >&2; exit 1; }

command -v node  >/dev/null 2>&1 || die "node not found"
command -v cargo >/dev/null 2>&1 || { [ -s "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"; }
command -v cargo >/dev/null 2>&1 || die "cargo not found — install Rust"

# GitHub auth: the gh CLI (already logged in) or a token in the environment.
GH_ENV_TOKEN="${GH_TOKEN:-${GITHUB_TOKEN:-${FA_GITHUB_TOKEN:-}}}"
if [ "$NO_UPLOAD" -eq 0 ]; then
  command -v gh >/dev/null 2>&1 || die "gh CLI not found (needed to upload; use --no-upload to skip)"
  gh auth status >/dev/null 2>&1 || [ -n "$GH_ENV_TOKEN" ] || die "not logged in to gh and no GH_TOKEN set"
fi

# ------------------------------------------------------------------ preflight

say "preflight"

VERSION="$(python3 -c "import json;print(json.load(open('$CONF'))['version'])")"
if [ -z "$TAG" ] && [ "$NO_UPLOAD" -eq 0 ]; then
  TAG="$(gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null || true)"
fi
[ -n "$TAG" ] || TAG="v$VERSION"
echo "    version         $VERSION"
echo "    release tag     $TAG"
if [ "$TAG" != "v$VERSION" ]; then
  echo "    !! tauri.conf.json is $VERSION but the tag is $TAG — check out the tagged commit first"
fi

# Updater signing key (the SAME minisign key the macOS release uses). Optional:
# without it we still build installable packages, just no auto-update entry.
HAVE_KEY=0
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  HAVE_KEY=1
  echo "    updater signing key  present (Linux auto-update will be wired)"
elif [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ] && [ -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]; then
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")"
  export TAURI_SIGNING_PRIVATE_KEY
  HAVE_KEY=1
  echo "    updater signing key  $TAURI_SIGNING_PRIVATE_KEY_PATH"
else
  echo "    updater signing key  NOT set — building .deb/.AppImage without an updater entry."
  echo "                         Set TAURI_SIGNING_PRIVATE_KEY to enable Linux auto-updates."
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# --------------------------------------------------------------------- build

if [ "$SKIP_BUILD" -eq 0 ]; then
  say "building the Linux bundle (Rust release + the bundled sidecar — a few minutes)"
  BUILD_ARGS=()
  if [ "$HAVE_KEY" -eq 0 ]; then
    # createUpdaterArtifacts is on in tauri.conf; without a key `tauri build`
    # would fail ("public key found, but no private key"). Turn it off for
    # this build only.
    BUILD_ARGS+=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
  fi
  # linuxdeploy (which builds the AppImage) and its plugins are themselves
  # AppImages; GitHub-hosted runners don't reliably support the FUSE mount an
  # AppImage normally uses to run itself, so make every nested AppImage
  # extract-and-run instead. --verbose so a real failure here isn't just
  # tauri-bundler's opaque "failed to run linuxdeploy".
  export APPIMAGE_EXTRACT_AND_RUN=1
  echo "    /dev/fuse: $( [ -e /dev/fuse ] && echo present || echo absent )"
  ( cd "$ROOT/desktop" && CI=true npm run tauri:build -- ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} --verbose )
else
  say "skipping build"
fi

# ---------------------------------------------------------------- collect

say "collecting artifacts"

DEB="$(ls -1 "$BUNDLE_DIR"/deb/*.deb 2>/dev/null | head -1 || true)"
APPIMAGE="$(ls -1 "$BUNDLE_DIR"/appimage/*.AppImage 2>/dev/null | grep -v '\.tar\.gz' | head -1 || true)"
[ -f "$DEB" ]      || die "no .deb produced under $BUNDLE_DIR/deb/"
[ -f "$APPIMAGE" ] || die "no .AppImage produced under $BUNDLE_DIR/appimage/"

# The updater artifact + its signature (Tauri v2 signs the AppImage directly;
# older layouts wrapped it in a .tar.gz — accept either).
UPDATER=""; UPDATER_SIG=""
if [ "$HAVE_KEY" -eq 1 ]; then
  for cand in "$APPIMAGE.sig" "$BUNDLE_DIR"/appimage/*.AppImage.tar.gz.sig; do
    [ -f "$cand" ] || continue
    UPDATER_SIG="$cand"
    UPDATER="${cand%.sig}"
    break
  done
  [ -n "$UPDATER_SIG" ] || die "TAURI_SIGNING_PRIVATE_KEY was set but no .AppImage(.tar.gz).sig was produced"
fi

DEB_NAME="Family-Agent-$VERSION-amd64.deb"
APPIMAGE_NAME="Family-Agent-$VERSION-amd64.AppImage"
printf '    %s\n' "$DEB -> $DEB_NAME" "$APPIMAGE -> $APPIMAGE_NAME"
[ -n "$UPDATER" ] && printf '    %s\n' "$UPDATER (+ .sig) -> $APPIMAGE_NAME (updater)"

if [ "$NO_UPLOAD" -eq 1 ]; then
  say "done (not uploaded)"
  exit 0
fi

# --------------------------------------------------------------- publish

say "attaching to $TAG"
[ -z "$GH_ENV_TOKEN" ] || export GH_TOKEN="$GH_ENV_TOKEN"

gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 \
  || die "release $TAG does not exist yet — the macOS release creates it; run that first"

gh release upload "$TAG" --repo "$REPO" --clobber \
  "$DEB#$DEB_NAME" \
  "$APPIMAGE#$APPIMAGE_NAME"

# Patch latest.json to add the linux platform, if we have a signed updater
# artifact. The macOS release wrote it with just darwin-*; we merge, not
# replace, so a re-run or a mac re-release stays intact.
if [ "$HAVE_KEY" -eq 1 ]; then
  say "adding linux-x86_64 to latest.json"
  TMP="$(mktemp -d)"
  gh release download "$TAG" --repo "$REPO" --pattern latest.json --dir "$TMP" --clobber \
    || die "could not fetch the current latest.json from $TAG"

  SIG="$(cat "$UPDATER_SIG")" \
  URL="https://github.com/$REPO/releases/download/$TAG/$APPIMAGE_NAME" \
  python3 - "$TMP/latest.json" <<'PY'
import json, os, sys
p = sys.argv[1]
m = json.load(open(p))
m.setdefault("platforms", {})
m["platforms"]["linux-x86_64"] = {"signature": os.environ["SIG"].strip(), "url": os.environ["URL"]}
json.dump(m, open(p, "w"), indent=2)
open(p, "a").write("\n")
print("    platforms now:", ", ".join(m["platforms"]))
PY

  gh release upload "$TAG" --repo "$REPO" --clobber "$TMP/latest.json#latest.json"
  rm -rf "$TMP"
fi

# ------------------------------------------------------------------- verify

say "verifying what a Linux client will fetch"
for asset in "$APPIMAGE_NAME" "$DEB_NAME"; do
  code="$(curl -s -o /dev/null -w '%{http_code}' -L "https://github.com/$REPO/releases/download/$TAG/$asset")"
  printf '    %s  %s\n' "$code" "$asset"
  [ "$code" = "200" ] || die "$asset is not fetchable (got $code)"
done
if [ "$HAVE_KEY" -eq 1 ]; then
  curl -s -L "https://github.com/$REPO/releases/latest/download/latest.json" \
    | python3 -c "import json,sys; d=json.load(sys.stdin); assert 'linux-x86_64' in d['platforms'], d['platforms']; print('    latest.json carries linux-x86_64 ✓')"
fi

cat <<EOF

Attached the Linux bundles to $TAG.

  https://github.com/$REPO/releases/tag/$TAG
EOF
