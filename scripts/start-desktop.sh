#!/usr/bin/env bash
# Starts the Tauri desktop app. It spawns agent-core itself as a sidecar —
# this script's only job is to check Ollama is actually ready first, since a
# failure there is confusing to debug from inside the app (see
# docs/DECISIONS.md for why the model check matters: not every model Ollama
# will happily serve supports the tool-calling this app depends on).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
DESKTOP_DIR="$ROOT_DIR/desktop"

OLLAMA_URL="${OLLAMA_BASE_URL:-http://127.0.0.1:11434}"
MODEL="${FAMILY_AGENT_MODEL:-gemma4:e2b}"

echo "==> Checking Ollama at $OLLAMA_URL ..."
TAGS_JSON="$(curl -s --max-time 3 "$OLLAMA_URL/api/tags" || true)"
if [ -z "$TAGS_JSON" ]; then
  echo "!! Could not reach Ollama at $OLLAMA_URL." >&2
  echo "   Start it first, e.g.: ollama serve &" >&2
  exit 1
fi

if ! grep -qF "\"$MODEL\"" <<<"$TAGS_JSON"; then
  echo "!! Model '$MODEL' is not pulled yet." >&2
  echo "   Run: ollama pull $MODEL" >&2
  echo "   (or set FAMILY_AGENT_MODEL to a model you've already pulled)" >&2
  exit 1
fi

echo "==> Ollama OK, '$MODEL' is available."
echo "==> Starting Tauri desktop app (this also launches agent-core) ..."
cd "$DESKTOP_DIR"
exec npm run tauri:dev
