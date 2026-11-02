#!/bin/sh
set -eu

# Run from the repository root; toolchain installation is documented in README.
scriptc=dist/toolchains/scriptc-0.4.7/bin/scriptc
node scripts/prepare-comparison.ts
npm run build
npm run build:perry
npm run build:scriptc:trial
node_modules/.bin/tsc scripts/compare-workload.ts --target ES2022 --module NodeNext \
  --rewriteRelativeImportExtensions --rootDir . --outDir dist/comparison/js --skipLibCheck

perry_build() {
  perry compile "$1" -o "dist/comparison/$2" --report-size \
    --strict-eval --strict-dynamic-import --strict-unimplemented > "dist/comparison/$2-build.log" 2>&1
}
scriptc_build() {
  "$scriptc" build "$1" --tier static-only --node-islands off -o "dist/comparison/$2"
}
perry_build scripts/compare-workload.ts engine-perry
scriptc_build scripts/compare-workload.ts engine-scriptc
for probe in hello stdio; do
  perry_build "dist/comparison/$probe.ts" "$probe-perry"
  scriptc_build "dist/comparison/$probe.ts" "$probe-scriptc"
done
perry_build tui/src/main.ts chess-perry-symbols
perry_build dist/comparison/no-unroll/tui/src/main.ts chess-perry-no-unroll

for artifact in engine-perry engine-scriptc hello-perry hello-scriptc stdio-perry stdio-scriptc chess-perry-symbols chess-perry-no-unroll; do
  cp "dist/comparison/$artifact" "dist/comparison/$artifact-stripped"
  strip "dist/comparison/$artifact-stripped"
  codesign --force --sign - "dist/comparison/$artifact-stripped"
done
cp dist/compiler-trials/chess-scriptc-adapted dist/comparison/chess-scriptc-stripped
strip dist/comparison/chess-scriptc-stripped
codesign --force --sign - dist/comparison/chess-scriptc-stripped
node scripts/analyze-native-size.ts \
  dist/comparison/chess-perry-symbols dist/comparison/engine-perry \
  dist/comparison/stdio-perry dist/comparison/hello-perry \
  dist/comparison/chess-perry-no-unroll dist/compiler-trials/chess-scriptc-adapted \
  dist/comparison/engine-scriptc dist/comparison/hello-scriptc dist/comparison/stdio-scriptc
