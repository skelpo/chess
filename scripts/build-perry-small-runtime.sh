#!/bin/sh
set -eu

# Run from the chess repository root. Source must match the installed Perry
# compiler. Nothing in the supplied source checkout is edited.
project_dir=$(pwd)
perry_source=$(cd "${1:?Usage: sh scripts/build-perry-small-runtime.sh /path/to/matching/perry-source}" && pwd)
case "${PERRY_SMALL_NO_REGEX:-0}" in
  0)
    runtime_dir="$project_dir/dist/perry-small/runtime"
    runtime_features="perry-runtime/keepalive-anchors,perry-runtime/regex-engine,perry-stdlib/async-bridge"
    ;;
  1)
    runtime_dir="$project_dir/dist/perry-small/runtime-no-regex"
    runtime_features="perry-runtime/keepalive-anchors,perry-stdlib/async-bridge"
    ;;
  *) echo "PERRY_SMALL_NO_REGEX must be 0 or 1" >&2; exit 1 ;;
esac
case "${PERRY_SMALL_MIMALLOC:-0}" in
  0) ;;
  1) runtime_features="$runtime_features,perry-runtime/alloc-mimalloc" ;;
  *) echo "PERRY_SMALL_MIMALLOC must be 0 or 1" >&2; exit 1 ;;
esac
runtime_dir="${PERRY_SMALL_RUNTIME_DIR:-$runtime_dir}"
profile="${PERRY_SMALL_PROFILE:-chess-small}"
profile_config="${PERRY_SMALL_CONFIG:-$project_dir/scripts/perry-small-runtime.toml}"
target_dir="${PERRY_SMALL_TARGET_DIR:-$project_dir/dist/perry-small/runtime-build}"
effects_bin="${GC_EFFECTS_BIN:-$perry_source/target/release/perry-gc-effects}"
effects_rules="${GC_EFFECTS_RULES:-$perry_source/scripts/gc_call_effects/seeds.txt}"
case "$target_dir" in /*) ;; *) target_dir="$project_dir/$target_dir" ;; esac
if [ ! -x "$effects_bin" ]; then
  echo "Set GC_EFFECTS_BIN to a matching built perry-gc-effects executable." >&2
  exit 1
fi
mkdir -p "$runtime_dir"
(
  cd "$perry_source"
  CARGO_TARGET_DIR="$target_dir" cargo --config "$profile_config" \
    build --profile "$profile" --locked -j 3 \
    -p perry-runtime-static -p perry-stdlib-static --no-default-features \
    --features "$runtime_features"
)
cp "$target_dir/$profile/libperry_runtime.a" "$runtime_dir/"
cp "$target_dir/$profile/libperry_stdlib.a" "$runtime_dir/"
if ! "$effects_bin" --root "$perry_source" --rules "$effects_rules" sidecars "$runtime_dir" > "$runtime_dir/gc-effects.log" 2>&1; then
  # Fat LTO can eliminate the standalone Arena destructor. Removing only
  # that unmatched teardown CUT is conservative; do not relax any GC seed,
  # unknown-call check, or archive fingerprint validation.
  python3 - "$perry_source" "$runtime_dir" "$effects_rules" <<'PY'
from pathlib import Path
import re
import sys
source, output, rules_path = map(Path, sys.argv[1:])
log = (output / "gc-effects.log").read_text()
expected = "teardown ^<perry_runtime::arena::block::Arena as core::ops::drop::Drop>::drop$"
unmatched = re.findall(r"^  seeds\.txt:\d+: (.+)$", log, re.MULTILINE)
if "named seed/cut rules that match NO node:" not in log or unmatched != [expected]:
    raise SystemExit("Unexpected GC effects analysis failure; inspect " + str(output / "gc-effects.log"))
rules = rules_path.read_text()
matches = [line for line in rules.splitlines(keepends=True)
           if line.startswith("teardown regex " + expected.removeprefix("teardown "))]
if len(matches) != 1:
    raise SystemExit("Expected exactly one Arena destructor teardown cut")
(output / "gc-effects-size-seeds.txt").write_text(rules.replace(matches[0],
    "# Size build: omit the unmatched Arena::drop teardown cut after fat LTO.\n"))
PY
  "$effects_bin" --root "$perry_source" --rules "$runtime_dir/gc-effects-size-seeds.txt" \
    sidecars "$runtime_dir"
fi
git -C "$perry_source" rev-parse HEAD > "$runtime_dir/source-commit.txt"
printf '%s\n' "$runtime_features" > "$runtime_dir/features.txt"
shasum -a 256 "$runtime_dir/libperry_runtime.a" "$runtime_dir/libperry_stdlib.a" > "$runtime_dir/archive-sha256.txt"
echo "Size-oriented runtime ready in $runtime_dir"
