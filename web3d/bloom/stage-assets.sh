#!/bin/sh
# Stage the web app's files in web3d/bloom/assets/web3d. Perry copies ./assets next to the binary
# (and into an .app), where dom.ts finds them; every build script runs this first.
set -e
cd "$(dirname "$0")"
rm -rf assets/web3d
mkdir -p assets/web3d/public/models assets/web3d/models/lod
cp ../index.html assets/web3d/
cp -R ../public/models/. assets/web3d/public/models/
cp -R ../public/audio assets/web3d/public/
cp ../models/lod/*.glb assets/web3d/models/lod/
echo "assets/web3d: $(du -sh assets/web3d | cut -f1)"
