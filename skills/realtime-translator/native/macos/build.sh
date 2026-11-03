#!/usr/bin/env bash
# Builds the macOS Core Audio tap helper (AudioTap.m) into <skill>/bin/audio-tap.
# Needs Xcode Command Line Tools with a macOS 14.4+ SDK (Xcode 15.3+). The helper is
# Objective-C on purpose: clang compiles it against any SDK without Swift-toolchain
# version coupling.
#
#   bash native/macos/build.sh              # host architecture
#   bash native/macos/build.sh --universal  # arm64 + x86_64
#
# MACOS_SDK=<path> overrides SDK selection. Otherwise the default SDK is used when it
# works, falling back to the newest installed CLT SDK that does (a CLT update can leave
# mismatched SDKs around).
set -euo pipefail
cd "$(dirname "$0")/../.."

OUT_DIR=bin
OUT="$OUT_DIR/audio-tap"
SRC=native/macos/AudioTap.m
FLAGS=(-fobjc-arc -O2 -Wall -mmacosx-version-min=13.0
  -framework CoreAudio -framework AudioToolbox -framework AppKit -framework Foundation)

mkdir -p "$OUT_DIR"

sdk_works() {
  local sdk="$1" probe ok
  probe="$(mktemp -d)"
  printf '#import <CoreAudio/CATapDescription.h>\nint main(void){return 0;}\n' > "$probe/probe.m"
  if clang -fobjc-arc -isysroot "$sdk" -framework Foundation "$probe/probe.m" \
    -o "$probe/probe" >/dev/null 2>&1; then ok=0; else ok=1; fi
  rm -rf "$probe"
  return $ok
}

pick_sdk() {
  if [[ -n "${MACOS_SDK:-}" ]]; then
    echo "$MACOS_SDK"
    return
  fi
  local default_sdk
  default_sdk="$(xcrun --show-sdk-path --sdk macosx 2>/dev/null || true)"
  if [[ -n "$default_sdk" ]] && sdk_works "$default_sdk"; then
    echo "$default_sdk"
    return
  fi
  local candidate
  for candidate in $(ls -d /Library/Developer/CommandLineTools/SDKs/MacOSX1*.sdk 2>/dev/null | sort -rV); do
    if sdk_works "$candidate"; then
      echo "$candidate"
      return
    fi
  done
  echo "error: no working macOS SDK with CATapDescription.h found" >&2
  exit 1
}

SDK="$(pick_sdk)"
echo "using SDK: $SDK"

if [[ "${1:-}" == "--universal" ]]; then
  clang -isysroot "$SDK" -arch arm64 -arch x86_64 "${FLAGS[@]}" "$SRC" -o "$OUT"
else
  clang -isysroot "$SDK" "${FLAGS[@]}" "$SRC" -o "$OUT"
fi

echo "built $OUT ($(lipo -archs "$OUT" 2>/dev/null || echo host))"
