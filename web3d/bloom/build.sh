#!/bin/sh
# Compile the unchanged web3d app (../src) into a native Bloom app with Perry.
#   sh web3d/bloom/build.sh            -> web3d/bloom/dist/tuichess3d
# Needs Perry, and the Bloom engine, @bloomengine/web and @bloomengine/three checked out next to
# this repo (../bloom/engine, ../bloom/web, ../bloom/three), linked into node_modules/@bloomengine.
set -e
cd "$(dirname "$0")"
BLOOM="${BLOOM:-../../../bloom}"
mkdir -p node_modules/@bloomengine
for p in engine web three; do
  [ -e "node_modules/@bloomengine/$p" ] || ln -s "../../$BLOOM/$p" "node_modules/@bloomengine/$p"
done
OUT="${OUT:-dist/tuichess3d}"
sh stage-assets.sh
mkdir -p "$(dirname "$OUT")"
# `three` -> the real three.js with a Bloom renderer, GLTFLoader -> its Bloom-aware subclass
ALIASES=$(cd .. && node bloom/node_modules/@bloomengine/three/bin/bloom-three.mjs aliases)
# shellcheck disable=SC2086
perry compile main.ts -o "$OUT" $ALIASES "$@"
