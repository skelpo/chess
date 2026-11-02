#!/bin/sh
set -eu

# Run from the repository root after building the patched compiler and the
# no-regex runtime described in README.md. The ordinary Perry build is intact.
compiler="${PERRY_SMALL_COMPILER:-$PWD/dist/perry-small/compiler/perry}"
if [ ! -x "$compiler" ]; then
  echo "Build the patched size compiler first; see README.md (Perry size builds)." >&2
  exit 1
fi
export PERRY_RUNTIME_DIR="$PWD/dist/perry-small/runtime-no-regex"
for artifact in libperry_runtime.a libperry_runtime.a.gc-effects libperry_stdlib.a features.txt; do
  if [ ! -f "$PERRY_RUNTIME_DIR/$artifact" ]; then
    echo "Missing no-regex runtime artifact: $artifact. Build it with PERRY_SMALL_NO_REGEX=1." >&2
    exit 1
  fi
done
if [ "$(cat "$PERRY_RUNTIME_DIR/features.txt")" != "perry-runtime/keepalive-anchors,perry-stdlib/async-bridge" ]; then
  echo "Unexpected runtime feature list in $PERRY_RUNTIME_DIR/features.txt" >&2
  exit 1
fi
export PERRY_LL_OPT_LEVEL=z
export PERRY_SPECIALIZED_ABI=0
node scripts/prepare-perry-small.ts --no-regex
case "${1:-build}" in
  build)
    "$compiler" compile dist/perry-small/no-regex-source/tui/src/main.ts \
      -o dist/chess-min --function-source header \
      --strict-eval --strict-dynamic-import --strict-unimplemented
    strip dist/chess-min
    codesign --force --sign - dist/chess-min
    ;;
  test)
    "$compiler" compile dist/perry-small/no-regex-source/tests/run.ts \
      -o dist/chess-min-tests --function-source header \
      --strict-eval --strict-dynamic-import --strict-unimplemented
    CHESS_TEST_TIMEOUT_MS="${CHESS_TEST_TIMEOUT_MS:-300000}" \
      CHESS_NATIVE=./dist/chess-min CHESS_NATIVE_TESTS=./dist/chess-min-tests \
      node tests/integration.ts
    node tests/text-parity.ts ./dist/chess-min
    python3 tests/terminal.py ./dist/chess-min
    ;;
  *) echo "Usage: sh scripts/perry-no-regex.sh build|test" >&2; exit 1 ;;
esac
