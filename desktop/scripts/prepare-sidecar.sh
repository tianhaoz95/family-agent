#!/usr/bin/env bash
# Stage a self-contained copy of agent-core + a Node runtime under
# desktop/src-tauri/sidecar/ so the bundled .app can run agent-core without a
# system Node or the repo checkout (see src-tauri/src/main.rs resolve_agent_core).
#
# `tauri.conf.json` ships `sidecar/` as bundle.resources, so in a packaged app
# these land at <resource_dir>/sidecar/{agent-core,node}.
#
# Idempotent: skips the (slow, downloading) production `npm install` when the
# staged copy is already current for the built agent-core. Runs from
# `beforeDevCommand` / `beforeBuildCommand` (cwd = desktop/); safe to run by hand.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$DESKTOP_DIR")"
AGENT_CORE="$ROOT_DIR/agent-core"
STAGE="$DESKTOP_DIR/src-tauri/sidecar"

if [ ! -d "$AGENT_CORE/dist" ]; then
  echo "!! agent-core/dist missing — run 'npm --prefix ../agent-core run build' first" >&2
  exit 1
fi

# A fingerprint of what the bundle depends on: the built JS + the dep manifest.
STAMP_INPUT="$(cd "$AGENT_CORE" && find dist -type f -exec shasum {} + | shasum; shasum package.json)"
STAMP="$(printf '%s' "$STAMP_INPUT" | shasum | cut -d' ' -f1)"
STAMP_FILE="$STAGE/.stamp"

if [ -f "$STAMP_FILE" ] && [ "$(cat "$STAMP_FILE")" = "$STAMP" ] \
   && [ -f "$STAGE/agent-core/dist/server.js" ] \
   && [ -d "$STAGE/agent-core/node_modules" ] \
   && [ -x "$STAGE/node" ]; then
  echo "==> prepare-sidecar: staged copy is current — skipping"
  exit 0
fi

echo "==> prepare-sidecar: staging into $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/agent-core"
cp -R "$AGENT_CORE/dist" "$STAGE/agent-core/dist"
cp "$AGENT_CORE/package.json" "$STAGE/agent-core/package.json"

# The Node binary (resolve nvm shim -> the real Mach-O).
NODE_BIN="$(command -v node || true)"
[ -n "$NODE_BIN" ] || { echo "!! no 'node' on PATH to bundle" >&2; exit 1; }
NODE_REAL="$(python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$NODE_BIN")"
cp "$NODE_REAL" "$STAGE/node"
chmod +x "$STAGE/node"

# Production deps, installed in isolation (the repo root is an npm workspace, so
# installing there hoists + pulls devDeps; a symlink to it loops the resource
# walker). A fresh resolve is slower but keeps the bundle lean and standalone.
echo "==> prepare-sidecar: installing production deps (downloads, ~40s first time)…"
( cd "$STAGE/agent-core" \
  && { npm install --omit=dev --no-audit --no-fund --loglevel=error --dangerously-allow-all-scripts 2>/dev/null \
       || npm install --omit=dev --no-audit --no-fund --loglevel=error; } )

# onnxruntime-node's Linux x64 prebuild ships an optional CUDA execution
# provider (.so) that links against libcublasLt.so.12 — a CUDA runtime lib
# nothing here has (ASR/TTS run CPU-only; we never request the CUDA provider).
# Harmless on macOS (the darwin prebuild has no such file, so these are no-ops
# there) but fatal for the Linux release: linuxdeploy hard-fails the whole
# AppImage bundle if it can't resolve an ELF dependency of anything it's
# deploying, CUDA or not. Drop it — the app is identical without it.
find "$STAGE/agent-core/node_modules/onnxruntime-node" \
  \( -name 'libonnxruntime_providers_cuda.so' -o -name 'libonnxruntime_providers_tensorrt.so' \) \
  -delete 2>/dev/null || true

printf '%s' "$STAMP" > "$STAMP_FILE"
echo "==> prepare-sidecar: done"
du -sh "$STAGE" 2>/dev/null || true
