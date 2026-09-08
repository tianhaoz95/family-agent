#!/usr/bin/env bash
# Gets the iOS app running on a simulator: finds a booted iPhone simulator, or
# boots one (preferring the newest iOS runtime), then builds, installs, and
# launches the app on it. The macOS counterpart of scripts/start-android.sh.
#
# Needs Xcode 16+ with an iOS 18+ simulator runtime.
#
# Usage: ./scripts/start-ios.sh [--device "iPhone 17 Pro"] [--login user:pass]
#   --device, -d   Simulator device name to boot if none is running.
#                  Default: FAMILY_AGENT_IOS_DEVICE, else the first available iPhone.
#   --login        DEBUG-only: pre-fill a server + auto sign in (user:pass).
#                  With it, also honours FAMILY_AGENT_SERVER_URL (default
#                  http://localhost:4173) and --start <destination>.
#   --start        DEBUG-only: which screen to open (chat, events, board, …).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
IOS_DIR="$ROOT_DIR/ios"

DEVICE_NAME="${FAMILY_AGENT_IOS_DEVICE:-}"
LOGIN=""
START=""
SERVER_URL="${FAMILY_AGENT_SERVER_URL:-http://localhost:4173}"

while [ $# -gt 0 ]; do
  case "$1" in
    -d|--device) DEVICE_NAME="${2:-}"; shift 2 ;;
    --device=*)  DEVICE_NAME="${1#*=}"; shift ;;
    --login)     LOGIN="${2:-}"; shift 2 ;;
    --login=*)   LOGIN="${1#*=}"; shift ;;
    --start)     START="${2:-}"; shift 2 ;;
    --start=*)   START="${1#*=}"; shift ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//' | sed -n '2,20p'
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done

if ! command -v xcodebuild >/dev/null 2>&1; then
  echo "!! xcodebuild not found — install Xcode (16 or newer)." >&2
  exit 1
fi
if [ ! -d "$IOS_DIR/FamilyAgent.xcodeproj" ]; then
  echo "!! $IOS_DIR/FamilyAgent.xcodeproj not found." >&2
  exit 1
fi

BUNDLE_ID="app.familyagent.ios"
SCHEME="FamilyAgent"
DD="$IOS_DIR/build"

booted_iphone() {
  xcrun simctl list devices booted 2>/dev/null \
    | grep -iE 'iphone' | grep -oE '\(([0-9A-F-]{36})\)' | tr -d '()' | head -1
}

UDID="$(booted_iphone || true)"

if [ -z "$UDID" ]; then
  if [ -z "$DEVICE_NAME" ]; then
    DEVICE_NAME="$(xcrun simctl list devices available 2>/dev/null \
      | grep -iE 'iPhone 1[5-9]|iPhone [2-9][0-9]' | head -1 \
      | sed -E 's/^[[:space:]]+//; s/ \([0-9A-F-]{36}\).*//')"
  fi
  [ -n "$DEVICE_NAME" ] || { echo "!! No available iPhone simulator. Add one in Xcode > Settings > Components." >&2; exit 1; }

  UDID="$(xcrun simctl list devices available 2>/dev/null \
    | grep -F "$DEVICE_NAME (" | grep -oE '\(([0-9A-F-]{36})\)' | tr -d '()' | head -1)"
  [ -n "$UDID" ] || { echo "!! Simulator '$DEVICE_NAME' not found." >&2; exit 1; }

  echo "==> Booting simulator: $DEVICE_NAME"
  xcrun simctl boot "$UDID" 2>/dev/null || true
  open -a Simulator
  xcrun simctl bootstatus "$UDID" -b >/dev/null 2>&1 || true
else
  echo "==> Using already-booted simulator: $UDID"
fi

echo "==> Resolving Swift package dependencies ..."
xcodebuild -resolvePackageDependencies -project "$IOS_DIR/FamilyAgent.xcodeproj" -scheme "$SCHEME" >/dev/null

echo "==> Building $SCHEME (Debug) ..."
xcodebuild -project "$IOS_DIR/FamilyAgent.xcodeproj" -scheme "$SCHEME" -configuration Debug \
  -destination "id=$UDID" -derivedDataPath "$DD" build >/dev/null

APP="$DD/Build/Products/Debug-iphonesimulator/FamilyAgent.app"
[ -d "$APP" ] || { echo "!! Build produced no .app at $APP" >&2; exit 1; }

echo "==> Installing and launching ..."
xcrun simctl install "$UDID" "$APP"

LAUNCH_ENV=()
if [ -n "$LOGIN" ]; then
  LAUNCH_ENV+=(SIMCTL_CHILD_FA_SERVER_URL="$SERVER_URL" SIMCTL_CHILD_FA_AUTOLOGIN="$LOGIN")
  [ -n "$START" ] && LAUNCH_ENV+=(SIMCTL_CHILD_FA_START="$START")
fi
env "${LAUNCH_ENV[@]}" xcrun simctl launch --terminate-running-process "$UDID" "$BUNDLE_ID" >/dev/null

cat <<EOF

==> Done. Family Agent is running on the simulator ($UDID).

    The simulator shares this Mac's network, so in the app point the server
    address at:
      http://localhost:4173

    Make sure agent-core is reachable there — the desktop app starts it
    automatically, or run it standalone:
      cd agent-core && npm run build && node dist/server.js
EOF
