#!/bin/sh
# Compiles cli/src/main.ts with Perry into plugin/bin/chess-engine-<os>-<arch>, the native engine the plugin runs.
set -eu
cd "$(dirname "$0")/.."
system=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64) arch=arm64 ;;
  *) arch=$(uname -m) ;;
esac
out="plugin/bin/chess-engine-$system-$arch"
mkdir -p plugin/bin
node scripts/prepare.ts
perry compile cli/src/main.ts -o "$out" --strict-eval --strict-dynamic-import --strict-unimplemented
strip "$out"
if [ "$system" = darwin ]; then codesign --force --sign - "$out"; fi
ls -l "$out"
