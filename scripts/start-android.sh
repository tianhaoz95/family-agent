#!/usr/bin/env bash
# Gets the Android app running: finds an already-running emulator, or
# creates + boots one if none is running (creating the AVD and, if needed,
# installing its system image first), then builds, installs, and launches
# the app on it. Mirrors the manual steps used to verify this app during
# development — see docs/DECISIONS.md ("Android emulator: got real device
# verification working") for why KVM access mattered here.
#
# Usage: ./scripts/start-android.sh [--memory MB]
#   --memory, -m   RAM (in MB) given to a newly-booted emulator. Ignored if
#                  an emulator is already running (its memory was fixed at
#                  its own boot time). Default 2048; also settable via
#                  FAMILY_AGENT_EMULATOR_MEMORY.
set -euo pipefail

MEMORY_MB="${FAMILY_AGENT_EMULATOR_MEMORY:-2048}"

while [ $# -gt 0 ]; do
  case "$1" in
    -m|--memory)
      MEMORY_MB="${2:-}"
      shift 2
      ;;
    --memory=*)
      MEMORY_MB="${1#*=}"
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [--memory MB]"
      echo "  --memory, -m   RAM in MB for a newly-booted emulator (default 2048)."
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      echo "Usage: $0 [--memory MB]" >&2
      exit 1
      ;;
  esac
done

if ! [[ "$MEMORY_MB" =~ ^[0-9]+$ ]]; then
  echo "!! --memory must be a plain number of MB, got: '$MEMORY_MB'" >&2
  exit 1
fi
if [ "$MEMORY_MB" -lt 1024 ]; then
  echo "==> Warning: ${MEMORY_MB}MB is very low for an emulator — it may fail to boot or run poorly." >&2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
ANDROID_DIR="$ROOT_DIR/android"
TOOLCHAINS_DIR="$ROOT_DIR/.toolchains"

export JAVA_HOME="${JAVA_HOME:-$TOOLCHAINS_DIR/jdk17}"
export ANDROID_HOME="${ANDROID_HOME:-$TOOLCHAINS_DIR/android-sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export PATH="$ANDROID_HOME/emulator:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"

AVD_NAME="${FAMILY_AGENT_AVD:-family-agent-test}"
SYSTEM_IMAGE="system-images;android-34;google_apis;x86_64"
APP_ID="app.familyagent.android"

if [ ! -x "$JAVA_HOME/bin/java" ]; then
  echo "!! JDK not found at $JAVA_HOME" >&2
  echo "   Set JAVA_HOME yourself, or see docs/BUILD_LOG.md's 'android' section" >&2
  echo "   for how the bundled toolchain was installed." >&2
  exit 1
fi
if [ ! -d "$ANDROID_HOME/platform-tools" ]; then
  echo "!! Android SDK not found at $ANDROID_HOME" >&2
  exit 1
fi

adb start-server >/dev/null 2>&1 || true

running_emulator() {
  adb devices | awk '$2 == "device" && $1 ~ /^emulator-/ { print $1; exit }'
}

echo "==> Checking for a running emulator ..."
SERIAL="$(running_emulator || true)"

if [ -n "$SERIAL" ]; then
  echo "==> Using already-running emulator: $SERIAL (--memory is ignored for an already-running emulator)"
else
  echo "==> No emulator running."

  if ! emulator -list-avds | grep -qx "$AVD_NAME"; then
    echo "==> AVD '$AVD_NAME' doesn't exist yet."

    if [ ! -d "$ANDROID_HOME/system-images/android-34/google_apis/x86_64" ]; then
      echo "==> System image not installed — installing now (this is a real download, ~1GB+) ..."
      yes | sdkmanager --sdk_root="$ANDROID_HOME" "emulator" "$SYSTEM_IMAGE" >/dev/null
    fi

    echo "==> Creating AVD '$AVD_NAME' ..."
    echo "no" | avdmanager create avd -n "$AVD_NAME" -k "$SYSTEM_IMAGE" -d pixel_6
  fi

  # Visible window by default — you're running this to use the app, not just
  # to verify it boots. Set FAMILY_AGENT_EMULATOR_HEADLESS=1 for a headless
  # instance instead (e.g. CI, or a machine with no display) — that mode is
  # what this script was verified against during development, since the dev
  # sandbox had no display of its own (see docs/DECISIONS.md).
  if [ "${FAMILY_AGENT_EMULATOR_HEADLESS:-0}" = "1" ]; then
    echo "==> Booting emulator '$AVD_NAME' (headless, FAMILY_AGENT_EMULATOR_HEADLESS=1, ${MEMORY_MB}MB RAM) ..."
    nohup emulator -avd "$AVD_NAME" -memory "$MEMORY_MB" -no-window -no-audio -no-boot-anim -gpu swiftshader_indirect \
      >/tmp/family-agent-emulator.log 2>&1 &
  else
    echo "==> Booting emulator '$AVD_NAME' (${MEMORY_MB}MB RAM, window should appear shortly) ..."
    nohup emulator -avd "$AVD_NAME" -memory "$MEMORY_MB" -no-boot-anim -gpu auto \
      >/tmp/family-agent-emulator.log 2>&1 &
  fi
  disown

  adb wait-for-device
  echo "==> Waiting for boot to complete ..."
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do
    sleep 2
  done

  SERIAL="$(running_emulator)"
  echo "==> Emulator ready: $SERIAL"
fi

export ANDROID_SERIAL="$SERIAL"

echo "==> Building and installing the app on $SERIAL ..."
cd "$ANDROID_DIR"
./gradlew installDebug

echo "==> Launching Family Agent ..."
adb -s "$SERIAL" shell am start -n "$APP_ID/.MainActivity" >/dev/null

cat <<EOF

==> Done. Family Agent is running on $SERIAL.

    In the app's Settings screen, point the server address at:
      http://10.0.2.2:4173

    That's the emulator's alias for this machine's localhost — make sure
    agent-core is actually reachable there (the desktop app starts it
    automatically, or run it standalone: node agent-core/dist/server.js).
EOF
