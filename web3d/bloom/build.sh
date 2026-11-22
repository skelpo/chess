#!/bin/sh
# Compile the unchanged web3d app (../src) into a native Bloom app with Perry.
#   sh web3d/bloom/build.sh            -> web3d/bloom/dist/tuichess3d (tuichess3d.exe on Windows)
# Needs Perry, and the Bloom engine, @bloomengine/web and @bloomengine/three checked out next to
# this repo (../bloom/engine, ../bloom/web, ../bloom/three), linked into node_modules/@bloomengine.
set -e
cd "$(dirname "$0")"
BLOOM="${BLOOM:-../../../bloom}"
mkdir -p node_modules/@bloomengine
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) WINDOWS=1 ;; *) WINDOWS= ;; esac
for p in engine web three; do
  [ -e "node_modules/@bloomengine/$p" ] && continue
  if [ -n "$WINDOWS" ]; then
    # symlinks need Developer Mode or admin on Windows; a directory junction doesn't
    MSYS2_ARG_CONV_EXCL='*' cmd /c mklink /J "$(cygpath -w "node_modules/@bloomengine/$p")" \
      "$(cygpath -w "$(cd "$BLOOM/$p" && pwd)")" >/dev/null
  else
    ln -s "../../$BLOOM/$p" "node_modules/@bloomengine/$p"
  fi
done
OUT="${OUT:-dist/tuichess3d${WINDOWS:+.exe}}"
sh stage-assets.sh
mkdir -p "$(dirname "$OUT")"
# `three` -> the real three.js with a Bloom renderer, GLTFLoader -> its Bloom-aware subclass
ALIASES=$(cd .. && node bloom/node_modules/@bloomengine/three/bin/bloom-three.mjs aliases)
# Windows: a GUI app, so starting it from Explorer opens no console window
# (WINDOWS_SUBSYSTEM=console keeps one, for logs when started by double-click)
SUBSYSTEM=${WINDOWS:+--windows-subsystem=${WINDOWS_SUBSYSTEM:-windows}}
# shellcheck disable=SC2086
perry compile main.ts -o "$OUT" $ALIASES $SUBSYSTEM "$@"
if [ -n "$WINDOWS" ]; then
  # DX12 needs the DirectX Shader Compiler beside the exe: without dxcompiler.dll and dxil.dll
  # wgpu drops the DX12 backend and the app fails at boot ("Failed to create surface")
  powershell -NoProfile -ExecutionPolicy Bypass -File "$(cygpath -w "$BLOOM/engine/tools/fetch-dxc.ps1")" \
    -Dest "$(cygpath -w "$(dirname "$OUT")")"
fi
