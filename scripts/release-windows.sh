#!/usr/bin/env bash
# Build the Windows desktop installer (NSIS .exe) and attach it to an existing
# GitHub release. The Windows counterpart of scripts/release-linux.sh — same
# shape, because Windows also has no OS-level notarization step:
#
#   • no `codesign`/`notarytool`/`stapler` — an unsigned .exe installs and
#     runs, it just shows a SmartScreen "unknown publisher" prompt on first
#     run (there is no code-signing cert wired up here at all yet);
#   • the ONLY signature is Tauri's own updater minisign, and only when
#     TAURI_SIGNING_PRIVATE_KEY is set. Without it the .exe still ships — it
#     just doesn't get an auto-update entry in latest.json.
#
#   ./scripts/release-windows.sh                 # attach to the latest release
#   ./scripts/release-windows.sh --tag v1.3.0    # a specific tag
#   ./scripts/release-windows.sh --skip-build    # reuse an existing bundle
#   ./scripts/release-windows.sh --no-upload     # build only, print the artifacts
#
# The macOS release (scripts/release-mac.sh) creates the tag + the GitHub
# release and its latest.json. This script only *adds* the Windows asset, so
# it runs after — driven by .github/workflows/release-windows.yml on
# `release: published`, or by hand on a Windows box with Git Bash.
#
# Runs under Git Bash (the shell GitHub's windows-latest runner and any dev
# box with Git for Windows both provide) rather than PowerShell/cmd, so this
# stays close to release-linux.sh instead of forking into a second language.
# JSON is handled with `node` (already a hard requirement below) rather than
# `python3` — same reasoning as the prepare-sidecar.sh portability fix this
# script's first run depends on: don't add a second interpreter's worth of
# platform risk to a builder that's already new.
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

# Git Bash (the shell this script runs under everywhere, including the
# Windows CI runner) hands back POSIX-style paths ("/d/a/..."). MSYS's own
# exec() auto-translates a *lone* argv token that looks like one of those
# into a native "D:\a\..." path before handing it to a non-MSYS program —
# but only when the whole argv is nothing but the path; embed it in a larger
# string (JS source passed to `node -e`) or glue a suffix onto it (gh's
# `path#label` upload syntax) and that heuristic doesn't fire, so node/gh
# get a path they can't resolve. Convert explicitly wherever either of those
# applies. No-op on mac/linux (no cygpath there).
to_native_path() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}

# Built natively on whatever architecture this runs on (an arm64 GitHub
# runner, e.g. windows-11-arm, produces an arm64 build — no cross-
# compilation). Normalized to Rust/Tauri's own naming (x86_64/aarch64,
# matching the updater platform keys darwin-aarch64 etc. already use) —
# `uname -m` under Git Bash on Windows has been seen to report either
# style depending on the Git for Windows build, so accept both.
# $WIN_ARCH is the installer filename's own convention (x64/arm64, what
# Windows users actually expect to see, not Rust's x86_64/aarch64).
case "$(uname -m)" in
  x86_64|amd64|AMD64)   ARCH="x86_64";  WIN_ARCH="x64" ;;
  aarch64|arm64|ARM64)  ARCH="aarch64"; WIN_ARCH="arm64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

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

VERSION="$(node -e "console.log(require(process.argv[1]).version)" "$(to_native_path "$CONF")")"
if [ -z "$TAG" ] && [ "$NO_UPLOAD" -eq 0 ]; then
  TAG="$(gh release view --repo "$REPO" --json tagName -q .tagName 2>/dev/null || true)"
fi
[ -n "$TAG" ] || TAG="v$VERSION"
echo "    version         $VERSION"
echo "    release tag     $TAG"
if [ "$TAG" != "v$VERSION" ]; then
  echo "    !! tauri.conf.json is $VERSION but the tag is $TAG — check out the tagged commit first"
fi

# Updater signing key (the SAME minisign key the macOS/Linux releases use).
# Optional: without it we still build an installable package, just no
# auto-update entry.
HAVE_KEY=0
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  HAVE_KEY=1
  echo "    updater signing key  present (Windows auto-update will be wired)"
elif [ -n "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" ] && [ -f "$TAURI_SIGNING_PRIVATE_KEY_PATH" ]; then
  TAURI_SIGNING_PRIVATE_KEY="$(cat "$TAURI_SIGNING_PRIVATE_KEY_PATH")"
  export TAURI_SIGNING_PRIVATE_KEY
  HAVE_KEY=1
  echo "    updater signing key  $TAURI_SIGNING_PRIVATE_KEY_PATH"
else
  echo "    updater signing key  NOT set — building the .exe without an updater entry."
  echo "                         Set TAURI_SIGNING_PRIVATE_KEY to enable Windows auto-updates."
fi
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD="${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}"

# --------------------------------------------------------------------- build

if [ "$SKIP_BUILD" -eq 0 ]; then
  say "building the Windows bundle (Rust release + the bundled sidecar — a few minutes)"
  BUILD_ARGS=()
  if [ "$HAVE_KEY" -eq 0 ]; then
    # createUpdaterArtifacts is on in tauri.conf; without a key `tauri build`
    # would fail ("public key found, but no private key"). Turn it off for
    # this build only.
    BUILD_ARGS+=(--config '{"bundle":{"createUpdaterArtifacts":false}}')
  fi
  ( cd "$ROOT/desktop" && CI=true npm run tauri:build -- ${BUILD_ARGS[@]+"${BUILD_ARGS[@]}"} --verbose )
else
  say "skipping build"
fi

# ---------------------------------------------------------------- collect

say "collecting artifacts"

INSTALLER="$(ls -1 "$BUNDLE_DIR"/nsis/*.exe 2>/dev/null | head -1 || true)"
[ -f "$INSTALLER" ] || die "no NSIS installer produced under $BUNDLE_DIR/nsis/"

# Tauri v2 signs the installer .exe itself for the updater — no separate
# wrapper archive (unlike the AppImage's historical .tar.gz layout).
UPDATER=""; UPDATER_SIG=""
if [ "$HAVE_KEY" -eq 1 ]; then
  [ -f "$INSTALLER.sig" ] || die "TAURI_SIGNING_PRIVATE_KEY was set but no $INSTALLER.sig was produced"
  UPDATER_SIG="$INSTALLER.sig"
  UPDATER="$INSTALLER"
fi

INSTALLER_NAME="Family-Agent-$VERSION-$WIN_ARCH-setup.exe"

# Tauri's built filename has spaces ("Family Agent_1.3.0_x64-setup.exe") and
# GitHub rewrites spaces in an uploaded asset's name to dots — copy to the
# name we actually want first, same reasoning as release-linux.sh.
STAGE_DIR="$(to_native_path "$(mktemp -d)")"
cp "$INSTALLER" "$STAGE_DIR/$INSTALLER_NAME"
INSTALLER="$STAGE_DIR/$INSTALLER_NAME"
printf '    %s\n' "-> $INSTALLER_NAME"
[ -n "$UPDATER" ] && printf '    %s\n' "$UPDATER.sig -> $INSTALLER_NAME (updater)"

if [ "$NO_UPLOAD" -eq 1 ]; then
  say "done (not uploaded)"
  exit 0
fi

# --------------------------------------------------------------- publish

say "attaching to $TAG"
[ -z "$GH_ENV_TOKEN" ] || export GH_TOKEN="$GH_ENV_TOKEN"

gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1 \
  || die "release $TAG does not exist yet — the macOS release creates it; run that first"

# Clean up any asset from a previous run that landed under Tauri's raw
# (space-in-name) filename before this script started renaming first.
gh release delete-asset "$TAG" --repo "$REPO" "Family.Agent_${VERSION}_${WIN_ARCH}-setup.exe" -y >/dev/null 2>&1 || true

gh release upload "$TAG" --repo "$REPO" --clobber "$INSTALLER"

# Patch latest.json to add the windows platform, if we have a signed updater
# artifact. mac, linux and windows all attach to the same release
# independently (no fixed ordering) and each merges its own key into this
# same shared file — download, add a key, re-upload — so two running at
# once can race: both download the same base, both upload, whichever lands
# last silently wins and drops the other's key. GitHub Releases has no
# conditional/compare-and-swap upload, so there's no way to prevent the
# race outright; instead, retry with verification — re-download after
# uploading and confirm our own key actually stuck, and if a concurrent
# writer clobbered it, redo the merge against whatever is there now. (An
# actual GitHub Actions concurrency lock across all three workflows was
# tried and reverted: when one `release: published` event fires all three
# simultaneously, GitHub's concurrency groups only keep the running run
# plus the *latest* queued one — a third simultaneous arrival is cancelled
# outright, not queued. Confirmed happening in practice.)
if [ "$HAVE_KEY" -eq 1 ]; then
  PLATFORM_KEY="windows-$ARCH"
  say "adding $PLATFORM_KEY to latest.json"
  FA_SIG="$(cat "$UPDATER_SIG")"
  FA_URL="https://github.com/$REPO/releases/download/$TAG/$INSTALLER_NAME"
  ATTEMPT=0
  while :; do
    ATTEMPT=$((ATTEMPT + 1))
    TMP="$(to_native_path "$(mktemp -d)")"
    gh release download "$TAG" --repo "$REPO" --pattern latest.json --dir "$TMP" --clobber 2>/dev/null || {
      echo "    no latest.json on $TAG yet (first platform to publish) — starting fresh"
      FA_VERSION="$VERSION" FA_LATEST_JSON="$TMP/latest.json" node -e '
        const fs = require("fs");
        fs.writeFileSync(process.env.FA_LATEST_JSON, JSON.stringify({
          version: process.env.FA_VERSION,
          notes: "See the release notes on GitHub.",
          pub_date: new Date().toISOString(),
          platforms: {},
        }, null, 2) + "\n");
      '
    }

    FA_SIG="$FA_SIG" FA_URL="$FA_URL" FA_LATEST_JSON="$TMP/latest.json" FA_PLATFORM_KEY="$PLATFORM_KEY" node -e '
      const fs = require("fs");
      const p = process.env.FA_LATEST_JSON;
      const m = JSON.parse(fs.readFileSync(p, "utf8"));
      m.platforms ??= {};
      m.platforms[process.env.FA_PLATFORM_KEY] = { signature: process.env.FA_SIG.trim(), url: process.env.FA_URL };
      fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");
      console.log("    platforms now:", Object.keys(m.platforms).join(", "));
    '

    gh release upload "$TAG" --repo "$REPO" --clobber "$TMP/latest.json#latest.json"

    VERIFY="$(to_native_path "$(mktemp -d)")"
    gh release download "$TAG" --repo "$REPO" --pattern latest.json --dir "$VERIFY" --clobber 2>/dev/null
    OURS_STUCK="$(FA_SIG="$FA_SIG" FA_LATEST_JSON="$VERIFY/latest.json" FA_PLATFORM_KEY="$PLATFORM_KEY" node -e '
      const fs = require("fs");
      try {
        const m = JSON.parse(fs.readFileSync(process.env.FA_LATEST_JSON, "utf8"));
        const p = m.platforms?.[process.env.FA_PLATFORM_KEY];
        console.log(p && p.signature === process.env.FA_SIG.trim() ? "yes" : "no");
      } catch { console.log("no"); }
    ' 2>/dev/null || echo no)"
    rm -rf "$TMP" "$VERIFY"
    [ "$OURS_STUCK" = "yes" ] && break
    if [ "$ATTEMPT" -ge 5 ]; then
      echo "    !! $PLATFORM_KEY didn't stick in latest.json after $ATTEMPT attempts (a concurrent writer keeps winning) — the installer is uploaded fine, but check latest.json by hand" >&2
      break
    fi
    echo "    a concurrent platform build overwrote latest.json first — retrying (attempt $ATTEMPT)"
    sleep $((RANDOM % 4 + 1))
  done
fi

# ------------------------------------------------------------------- verify

say "verifying what a Windows client will fetch"
# A freshly-uploaded asset can 404 for a few seconds before GitHub's CDN picks
# it up — retry briefly instead of failing on what is almost always just
# propagation lag (same as release-linux.sh / release-mac.sh).
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
code="$(fetchable "https://github.com/$REPO/releases/download/$TAG/$INSTALLER_NAME")" || die "$INSTALLER_NAME is not fetchable (got $code)"
printf '    %s  %s\n' "$code" "$INSTALLER_NAME"
if [ "$HAVE_KEY" -eq 1 ]; then
  curl -s -L "https://github.com/$REPO/releases/latest/download/latest.json" \
    | FA_PLATFORM_KEY="windows-$ARCH" node -e '
      const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const key = process.env.FA_PLATFORM_KEY;
      if (!d.platforms[key]) throw new Error(JSON.stringify(d.platforms));
      console.log(`    latest.json carries ${key} ✓`);
    '
fi

cat <<EOF

Attached the Windows installer to $TAG.

  https://github.com/$REPO/releases/tag/$TAG
EOF
