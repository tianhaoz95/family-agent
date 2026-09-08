#!/usr/bin/env bash
# Starts the Tauri desktop app in dev mode (Linux .deb/.appimage host, or macOS).
# It spawns agent-core itself as a sidecar — this script rebuilds agent-core
# first and does a best-effort Ollama readiness check, since a model failure is
# confusing to debug from inside the app (see docs/DECISIONS.md for why the
# model check matters: not every model Ollama will serve supports the
# tool-calling this app depends on).
#
# Env: OLLAMA_BASE_URL (default http://127.0.0.1:11434), FAMILY_AGENT_MODEL.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DESKTOP_DIR="$ROOT_DIR/desktop"

OLLAMA_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
MODEL="${FAMILY_AGENT_MODEL:-gemma4:e2b}"

echo "==> Checking Ollama at $OLLAMA_URL ..."
TAGS_JSON="$(curl -s --max-time 3 "$OLLAMA_URL/api/tags" || true)"
if [ -z "$TAGS_JSON" ]; then
  echo "!! Could not reach Ollama at $OLLAMA_URL — the app will start, but chat /"
  echo "   the planner won't work until Ollama is reachable. Start it with"
  echo "   'ollama serve &', or set OLLAMA_BASE_URL to a remote instance." >&2
elif ! grep -qF "\"$MODEL\"" <<<"$TAGS_JSON"; then
  echo "!! Model '$MODEL' isn't pulled at $OLLAMA_URL. Run 'ollama pull $MODEL'"
  echo "   or set FAMILY_AGENT_MODEL to one you have. Starting anyway." >&2
else
  echo "==> Ollama OK, '$MODEL' is available."
fi

# The Tauri shell spawns agent-core's *built* dist/server.js (see
# desktop/src-tauri/src/main.rs) — `tauri dev` only hot-reloads the frontend,
# not agent-core. Always rebuild first; `beforeDevCommand` also re-runs this
# plus prepare-sidecar.sh, but building here surfaces TS errors up front.
echo "==> Building agent-core (dist/server.js) ..."
npm --prefix "$ROOT_DIR/agent-core" run build

echo "==> Starting Tauri desktop app (this also launches agent-core) ..."
echo "    (macOS: 'npm --prefix desktop run tauri:build:mac' makes the .app + .dmg)"
cd "$DESKTOP_DIR"
exec npm run tauri:dev
