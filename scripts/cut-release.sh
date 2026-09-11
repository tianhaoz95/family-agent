#!/usr/bin/env bash
# Publish an empty GitHub release for the version currently in
# tauri.conf.json — no assets. That's the starting gun: mac, linux and
# windows each have a workflow triggered on `release: published`
# (.github/workflows/release-{mac,linux,windows}.yml) that reacts to this by
# building, signing (mac/windows optionally), and attaching its own
# installer, independently of the others. Run this once per version; the
# three platform builds do the rest.
#
#   ./scripts/cut-release.sh                # publish v<tauri.conf.json version>
#   ./scripts/cut-release.sh --draft        # create it as a draft (no workflows
#                                            #   fire until you publish it by hand)
#   ./scripts/cut-release.sh --version 1.4.0  # bump the version first, then release
#
# This intentionally does NOT build anything itself — see
# .github/workflows/release-{mac,linux,windows}.yml for that, or run
# scripts/release-mac.sh locally for the old one-command-does-everything path.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
CONF="$ROOT/desktop/src-tauri/tauri.conf.json"
REPO="tianhaoz95/family-agent"

DRAFT=0; NEW_VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --draft)   DRAFT=1; shift ;;
    --version) NEW_VERSION="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "!! unknown argument: $1" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
die() { echo "!! $*" >&2; exit 1; }

command -v gh >/dev/null 2>&1 || die "gh CLI not found"
gh auth status >/dev/null 2>&1 || die "not logged in to gh"

if [ -n "$NEW_VERSION" ]; then
  echo "$NEW_VERSION" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+$' || die "--version must be X.Y.Z"
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    d.version = process.argv[2];
    fs.writeFileSync(p, JSON.stringify(d, null, 2) + "\n");
  ' "$CONF" "$NEW_VERSION"
  echo "    version set to $NEW_VERSION in $CONF — commit that before releasing"
fi

VERSION="$(node -e "console.log(require('$CONF').version)")"
TAG="v$VERSION"

if git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | grep -q "$TAG"; then
  die "tag $TAG already exists on origin. Bump with --version X.Y.Z (and commit it) first."
fi
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
  die "a release for $TAG already exists: https://github.com/$REPO/releases/tag/$TAG"
fi
[ -z "$(git status --porcelain)" ] || echo "!! working tree is dirty — the release will tag whatever's on origin/HEAD, not your local changes"

NOTES="Family Agent $VERSION

Built and signed by CI for macOS, Linux and Windows. Assets appear here as
each platform's build finishes — give it a few minutes if one is missing."

say "publishing $TAG (no assets — mac/linux/windows workflows attach their own)"
FLAGS=(--repo "$REPO" --title "Family Agent $VERSION" --notes "$NOTES")
[ "$DRAFT" -eq 1 ] && FLAGS+=(--draft)
gh release create "$TAG" "${FLAGS[@]}"

if [ "$DRAFT" -eq 1 ]; then
  cat <<EOF

Created as a draft — nothing will build until you publish it:
  https://github.com/$REPO/releases/tag/$TAG
EOF
else
  cat <<EOF

Published $TAG — mac, linux and windows builds should be starting now:
  https://github.com/$REPO/actions
  https://github.com/$REPO/releases/tag/$TAG
EOF
fi
