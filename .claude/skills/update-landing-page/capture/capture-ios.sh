#!/usr/bin/env bash
# Capture iOS app screens for the landing page.
#
#   ./capture-ios.sh <out-dir> [screen ...]
#
# Screens are `Destination` raw values: chat messages events board documents
# tools routines skills connections vault activity settings
# Default set is the ones the site actually uses.
#
# Requires a booted simulator, an agent-core reachable at localhost:4173 with
# content in it, and DEBUG launch hooks (FA_SERVER_URL / FA_AUTOLOGIN / FA_START)
# which only exist in Debug builds — see ios/README.md.
#
# Screenshots come out with the simulator's own status bar. That is fine: the
# site frames them as devices, so the status bar reads as part of the phone.
set -euo pipefail

cd "$(dirname "$0")/../../../.."
ROOT="$PWD"

OUT="${1:-/tmp/ios-captures}"; shift || true
SCREENS=("$@")
[ ${#SCREENS[@]} -eq 0 ] && SCREENS=(chat events documents board vault routines)

SERVER="${FA_CAPTURE_SERVER:-http://localhost:4173}"
USER="${FA_CAPTURE_USER:-dad}"
PASS="${FA_CAPTURE_PASS:-testpass}"
BUNDLE="app.familyagent.ios"

# xcodebuild/simctl live under Xcode, not CommandLineTools. This is a common
# footgun on this machine — fail with the fix rather than "command not found".
if ! xcrun --find simctl >/dev/null 2>&1; then
  cat >&2 <<'EOF'
!! simctl not found. The active developer directory is probably CommandLineTools:

     xcode-select -p
     sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
EOF
  exit 1
fi

curl -sf "$SERVER/health" >/dev/null || {
  echo "!! no agent-core at $SERVER — start one with content before capturing." >&2
  echo "   .claude/skills/update-landing-page/capture/capture-desktop.sh starts one." >&2
  exit 1
}

DEVICE="$(xcrun simctl list devices booted | grep -oE '\([0-9A-F-]{36}\)' | head -1 | tr -d '()')"
if [ -z "$DEVICE" ]; then
  DEVICE="$(xcrun simctl list devices available | grep -E 'iPhone 1[6-9]|iPhone [2-9][0-9]' \
            | grep -oE '\([0-9A-F-]{36}\)' | head -1 | tr -d '()')"
  [ -n "$DEVICE" ] || { echo "!! no iPhone simulator available" >&2; exit 1; }
  echo "==> booting $DEVICE"
  xcrun simctl boot "$DEVICE"
  sleep 12
fi
echo "==> device $DEVICE"

APP="$(find "$ROOT/ios/build" /tmp/fa-dd -name 'FamilyAgent.app' -path '*Debug-iphonesimulator*' 2>/dev/null | head -1)"
if [ -n "$APP" ]; then
  echo "==> installing $APP"
  xcrun simctl install "$DEVICE" "$APP"
else
  echo "==> no freshly built .app found; using whatever is installed"
  echo "    (build with: ./scripts/start-ios.sh, or xcodebuild -scheme FamilyAgent)"
fi

mkdir -p "$OUT"
for screen in "${SCREENS[@]}"; do
  SIMCTL_CHILD_FA_SERVER_URL="$SERVER" \
  SIMCTL_CHILD_FA_AUTOLOGIN="$USER:$PASS" \
  SIMCTL_CHILD_FA_START="$screen" \
    xcrun simctl launch --terminate-running-process "$DEVICE" "$BUNDLE" >/dev/null
  sleep 5
  xcrun simctl io "$DEVICE" screenshot "$OUT/$screen.png" >/dev/null 2>&1
  echo "    $OUT/$screen.png"
done

echo "==> done. Downscale for the site with:"
echo "    sips -Z 880 -s format jpeg -s formatOptions 84 $OUT/<screen>.png --out site/img/<name>.jpg"
