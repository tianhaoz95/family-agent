#!/usr/bin/env bash
# Capture the macOS desktop app's UI for the landing page.
#
#   ./capture-desktop.sh [out.png] [--view SELECTOR] [--width N] [--height N]
#
# Starts a throwaway agent-core and the Vite dev server, renders the real
# frontend through WKWebView signed in as a real account, then stops both. The
# result is a screenshot of the running app, not a mock.
#
# It runs on ITS OWN PORTS (4273/4274) rather than the defaults. The installed
# Family Agent.app keeps a sidecar on 4173, and an earlier version of this script
# happily reused it — then failed to log in, because that server has the real
# household's accounts and a different data directory. Isolating the ports means
# the capture never depends on, or disturbs, whatever else is running.
#
# 1120x720 is the default viewport on purpose: the app laid out at 1440 and then
# scaled into the hero is unreadable, so a tighter viewport keeps the UI
# proportionally larger.
set -euo pipefail

cd "$(dirname "$0")/../../../.."
ROOT="$PWD"
HERE="$ROOT/.claude/skills/update-landing-page/capture"

OUT="/tmp/desktop-capture.png"
if [ $# -gt 0 ] && [ "${1:0:2}" != "--" ]; then OUT="$1"; shift; fi

VIEW=".session-row"          # opens the first saved chat so the transcript isn't empty
WIDTH=1120
HEIGHT=720
PORT="${FA_CAPTURE_PORT:-4273}"
TOOLS_PORT=$((PORT + 1))
VITE_PORT=1420
DATA_DIR="${FA_CAPTURE_DATA_DIR:-/tmp/fa-capture}"
USER="${FA_CAPTURE_USER:-dad}"
PASS="${FA_CAPTURE_PASS:-testpass}"

while [ $# -gt 0 ]; do
  case "$1" in
    --view)   VIEW="$2"; shift 2 ;;
    --width)  WIDTH="$2"; shift 2 ;;
    --height) HEIGHT="$2"; shift 2 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "!! unknown argument: $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null 2>&1 || { [ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1 || true; }
command -v node >/dev/null 2>&1 || { echo "!! node not found (nvm not loaded?)" >&2; exit 1; }

# Kill by PORT, not by recorded PID. Both node and vite re-exec / spawn
# children, so the pid captured from `$!` is often not the process holding the
# socket — an earlier version left agent-core running on 4273 after exit.
cleanup() {
  for p in "$PORT" "$TOOLS_PORT" "$VITE_PORT"; do
    lsof -ti :"$p" 2>/dev/null | xargs -r kill 2>/dev/null || true
  done
  sleep 1
  for p in "$PORT" "$TOOLS_PORT" "$VITE_PORT"; do
    lsof -ti :"$p" 2>/dev/null | xargs -r kill -9 2>/dev/null || true
  done
}
trap cleanup EXIT

for p in "$PORT" "$TOOLS_PORT"; do
  lsof -ti :"$p" >/dev/null 2>&1 && { echo "!! port $p is busy; set FA_CAPTURE_PORT" >&2; exit 1; }
done
if lsof -ti :"$VITE_PORT" >/dev/null 2>&1; then
  echo "!! port $VITE_PORT is busy — stop any running \`npm run tauri:dev\` first." >&2
  echo "   (vite is pinned to $VITE_PORT with strictPort, so it cannot move.)" >&2
  exit 1
fi

echo "==> agent-core on $PORT (data: $DATA_DIR)"
( cd "$ROOT/agent-core" && npm run build >/dev/null 2>&1 || true )
( cd "$ROOT/agent-core" && PORT="$PORT" FAMILY_AGENT_TOOLS_PORT="$TOOLS_PORT" \
    FAMILY_AGENT_DATA_DIR="$DATA_DIR" node dist/server.js > /tmp/fa-capture-core.log 2>&1 & )
for _ in $(seq 1 30); do curl -sf "localhost:$PORT/health" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "localhost:$PORT/health" >/dev/null || { tail -8 /tmp/fa-capture-core.log >&2; exit 1; }

if curl -s "localhost:$PORT/auth/status" | grep -q '"needsSetup":true'; then
  echo "    bootstrapping $USER (fresh data dir)"
  curl -s -X POST "localhost:$PORT/auth/bootstrap" -H 'content-type: application/json' \
    -d "{\"serverName\":\"Home\",\"username\":\"$USER\",\"displayName\":\"Dad\",\"password\":\"$PASS\"}" >/dev/null
fi

TOKEN=$(curl -s -X POST "localhost:$PORT/auth/login" -H 'content-type: application/json' \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" \
  | python3 -c 'import sys,json;print(json.load(sys.stdin).get("token",""))')
[ -n "$TOKEN" ] || {
  echo "!! login failed for '$USER' against $DATA_DIR." >&2
  echo "   That data dir has different accounts. Either point FA_CAPTURE_DATA_DIR" >&2
  echo "   at a fresh directory, or set FA_CAPTURE_USER / FA_CAPTURE_PASS." >&2
  echo "   Accounts present: ./scripts/show-accounts.sh" >&2
  exit 1
}
echo "    signed in as $USER"

echo "==> vite on $VITE_PORT, pointed at $PORT"
( cd "$ROOT/desktop" && VITE_API_BASE="http://127.0.0.1:$PORT" \
    npm run dev > /tmp/fa-capture-vite.log 2>&1 & )
for _ in $(seq 1 45); do curl -s -o /dev/null "localhost:$VITE_PORT" 2>/dev/null && break; sleep 1; done
curl -s -o /dev/null "localhost:$VITE_PORT" || { tail -8 /tmp/fa-capture-vite.log >&2; exit 1; }

echo "==> rendering ${WIDTH}x${HEIGHT}"
swift "$HERE/render-web.swift" "http://localhost:$VITE_PORT/" "$OUT" \
  --width "$WIDTH" --height "$HEIGHT" --settle 6 --token "$TOKEN" --click "$VIEW"

echo "==> $OUT"
echo "    downscale for the site:"
echo "    sips -Z 1300 -s format jpeg -s formatOptions 86 \"$OUT\" --out site/img/desktop-chat.jpg"
