#!/usr/bin/env bash
# Builds the mistralrs-node native addon (mistral.rs embedded as a Rust
# library, NOT the mistralrs-server CLI — see native/mistralrs-node/src/lib.rs)
# for the CURRENT platform/arch only, and copies the result into
# native/mistralrs-node/prebuilds/<platform>-<arch>/mistralrs-node.node —
# the layout agent-core/src/mistralrs/nativeAddon.ts looks it up from
# (node-gyp-build's own convention, hand-rolled here to avoid the extra dep).
#
# This does NOT cross-compile for other platforms. A release covering
# mac/Linux/Windows needs this run once per OS (e.g. once per platform's own
# CI runner), same shape as the desktop app's own per-OS release workflows.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CRATE_DIR="$SCRIPT_DIR/../native/mistralrs-node"

cd "$CRATE_DIR"
echo "==> Building mistralrs-node (release) — this compiles mistral.rs + candle, first build is slow ..."
cargo build --release

case "$(uname -s)" in
  Darwin) LIB_NAME="libmistralrs_node.dylib" ;;
  Linux) LIB_NAME="libmistralrs_node.so" ;;
  MINGW*|MSYS*|CYGWIN*) LIB_NAME="mistralrs_node.dll" ;;
  *) echo "!! Unrecognized OS: $(uname -s)" >&2; exit 1 ;;
esac

NODE_PLATFORM="$(node -e 'process.stdout.write(process.platform)')"
NODE_ARCH="$(node -e 'process.stdout.write(process.arch)')"
OUT_DIR="$CRATE_DIR/prebuilds/${NODE_PLATFORM}-${NODE_ARCH}"
mkdir -p "$OUT_DIR"
cp "$CRATE_DIR/target/release/$LIB_NAME" "$OUT_DIR/mistralrs-node.node"

echo "==> Built $OUT_DIR/mistralrs-node.node"
