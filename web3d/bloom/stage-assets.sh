#!/bin/sh
# Stage the web app's files in web3d/bloom/assets/web3d. Perry copies ./assets next to the binary
# (and into an .app), where dom.ts finds them; every build script runs this first.
#
# Themed pieces are drawn from copies with each side's colors baked in (tint-sets.mjs, tinted.ts),
# so their originals stay out: three.js reads the white copy (the same skeleton and clips).
set -e
cd "$(dirname "$0")"
rm -rf assets/web3d
mkdir -p assets/web3d/public/models assets/web3d/models/lod
cp ../index.html assets/web3d/
cp -R ../public/models/. assets/web3d/public/models/
cp ../public/splash.png assets/web3d/public/
# sounds and music (src/audio.ts reads public/audio/manifest.json)
[ -d ../public/audio ] && cp -R ../public/audio assets/web3d/public/
cp ../models/lod/*.glb assets/web3d/models/lod/
node tint-sets.mjs ../public/models assets/web3d/tinted
for baked in assets/web3d/tinted/*/*-white.glb; do
  theme=$(basename "$(dirname "$baked")")
  rm -f "assets/web3d/public/models/$theme/$(basename "$baked" -white.glb).glb"
done
echo "assets/web3d: $(du -sh assets/web3d | cut -f1)"
