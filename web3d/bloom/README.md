# web3d on Bloom

The unchanged web3d app (`../src`, three.js) compiled by Perry into a
native [Bloom](../../../bloom/engine) app: a window with Bloom's renderer,
no browser and no WebGL. Nothing in `../src` changes for this build.

```bash
sh web3d/bloom/build.sh          # -> web3d/bloom/dist/tuichess3d  (about 2.5 min the first time)
./web3d/bloom/dist/tuichess3d
```

This needs Perry, and three repos checked out next to this one: the Bloom engine
(`../bloom/engine`), [@bloomengine/web](https://github.com/Bloom-Engine/web) (`../bloom/web`) and
[@bloomengine/three](https://github.com/Bloom-Engine/three) (`../bloom/three`). `build.sh` links them
into `node_modules/@bloomengine` and compiles with `bloom-three`'s module aliases.

## How it works

The generic parts are packages; this folder holds only what is about this app.

| | |
|---|---|
| `@bloomengine/web` | A browser over Bloom: the DOM (index.html parsed into it), input as DOM events, `fetch` for the app's files, `localStorage` saved to a file, the 2D canvas for the board texture, and Web Audio and `<audio>` over Bloom's mixer, so `../src/audio.ts` plays music and effects unchanged |
| `@bloomengine/three` | The real three.js with a renderer that mirrors the scene into Bloom, and a GLTFLoader that marks skinned models for Bloom's GPU skinning. three's own OrbitControls runs on the DOM as in the browser |
| `config.ts` | The app's settings (window, where index.html is, storage file) and three hooks: three.js parses the low-poly pieces (`../models/lod`), Bloom draws the full ones, themed pieces from their baked copies (`tinted.ts`), tinted by the Body material |
| `hooks.ts`, `tv.ts` | Apple TV (the board cursor and focus in menus) and the `BLOOM_SCRIPT` commands that drive the game |
| `overlay.ts` | The Apple TV board cursor, over the page |

`../src` doesn't change for this build.

## The menu

The menu, HUD and dialogs are ordinary HTML and CSS in `../index.html`, the usual way to put a
page over a three.js canvas. @bloomengine/web's CSS engine draws them natively from that
stylesheet: flex and grid layout, the panels' rounded borders and shadows, the backdrop's radial
gradient, the screens' fade and rise animations, `:hover`, `:focus-visible` and `aria-pressed`
states. A change to the page's CSS shows up here without touching this folder. Not drawn:
`backdrop-filter` (the panels aren't blurred) and color emoji. `overlay.ts` draws the Apple TV
board cursor on top.

`localStorage` is saved to `$BLOOM_STORAGE`, or `web3d-storage.json` in the terminal app's config
folder (`~/.config/tuichess`, or `$TUICHESS_HOME`), so settings and the game in progress survive a
restart. The native build shows a Quit button: the page shows it when `nativeApp` exists.

## Flicker: the camera's clip planes

Bloom draws 3D with a near plane of 0.01 by default. From about 15 units away
that resolves only about a millimetre of depth. The board top sits 1 mm
above its frame, so the two z-fought: blocks of the board flickered to the
frame's color while the camera moved, and on every frame with TAA, whose
jitter moves the projection slightly each frame.
The renderer passes three's `camera.near` and `camera.far` (0.1 and
100) to Bloom's new `setCameraClipPlanes`, which fixes it. A still board now
changes about 300 pixels between frames with TAA on, and the camera can
move without artifacts.

## iPhone and iPad

The same build runs on iOS (Metal), from `build-ios.sh` and `perry.toml`
(bundle id `com.skelpo.tuichess`, display name, version, icon):

```bash
sh web3d/bloom/build-ios.sh sim        # simulator: build, install, launch on the booted simulator
sh web3d/bloom/build-ios.sh device     # iPhone: build, sign for development, install and launch
sh web3d/bloom/build-ios.sh appstore   # App Store: build, sign for distribution -> dist/ios/tuichess3d.ipa
```

What differs on a phone, all in this folder (`../src` is unchanged):

- **Files:** an iOS app can't read the build machine's disk. The script copies
  `index.html`, the models and the sounds into `assets/web3d/`, Perry bundles
  `assets/` into the `.app`, and @bloomengine/web reads them next to the executable.
  `localStorage` goes to the app's `Library/Application Support`.
- **Screen:** Bloom reports device pixels on iOS. The page is laid out in CSS
  pixels and drawn at the screen's pixel ratio (2 on iPads, 3 on most
  iPhones), and pointer events report CSS pixels as in a browser. The HUD and
  the menu keep out of the safe area (Dynamic Island, notch, home indicator).
  (@bloomengine/web's `pixelRatio()` and `safeArea()`.)
  A menu taller than a phone on its side is zoomed out to fit.
- **Touch:** tap is a click. Each finger is its own pointer (and a touch event),
  so three's OrbitControls pinches to zoom as in a phone's browser. Hover only
  shows while a finger is down. The help screen shows touch controls
  (`.for-touch` / `.for-mouse`, chosen by `(pointer: coarse)`, as on a phone's
  browser).
- **No Quit:** iOS apps don't close themselves, so `nativeApp` isn't defined there.
- **Rendering:** every orientation is allowed. The render scale starts at 0.6,
  and Bloom's automatic resolution keeps 60 Hz.

Perry needs its runtime, stdlib and UI library built for each iOS target. From the
Perry checkout (with its pinned toolchain's `aarch64-apple-ios` and
`aarch64-apple-ios-sim` targets added):

```bash
for t in aarch64-apple-ios aarch64-apple-ios-sim; do
  cargo build --release --target $t -p perry-runtime -p perry-runtime-static -p perry-stdlib -p perry-stdlib-static -p perry-ui-ios
  scripts/gc_call_effects/sidecars.sh target/$t/release
done
```

A `perry` wrapper that exports `PERRY_RUNTIME_DIR` to the macOS libraries would
make the iOS link pick those up. `build-ios.sh` points it at the target's
libraries instead (or set `PERRY_IOS_LIBS`).

**Signing.**
- `device` signs with the first "Apple Development" identity and an installed
  development profile for the bundle id. The team's wildcard profile works.
- `appstore` needs an App Store profile for `com.skelpo.tuichess`
  (`DIST_PROFILE=...`), and the app must exist in App Store Connect.
- Upload the `.ipa` with Transporter or `xcrun altool --upload-app`.
- `perry publish ios` can't be used here: it builds on Perry's servers from
  this folder alone, and the app's sources (`../src`, three, Bloom) live
  outside it.

`icon.png` is rendered by `web3d/models/icon.py` (Blender, the game's knight).

## Switches

| Variable | Effect |
|---|---|
| `BLOOM_QUALITY=off\|low\|medium\|high\|ultra` | Bloom quality preset. The default is `medium`: about 6 ms a frame here. `high`, `ultra` and Bloom's no-preset default cost about 90 ms with 32 skinned pieces at Retina resolution |
| `BLOOM_TAA=0\|1`, `BLOOM_SCALE=0.15..1` | Override the preset's TAA and render scale |
| `BLOOM_STORAGE=<file>` | Where `localStorage` is saved |
| `BLOOM_LOD=1` | Draw the low-poly pieces on the GPU too |
| `BLOOM_PROFILE=1` | Bloom's frame profiler: per-pass CPU and GPU times, printed by the `profile` script command. It waits for the GPU every frame, so frames run slower while it is on, and the per-pass GPU times on Apple GPUs overlap (one pass can show more time than the whole frame) |
| `BLOOM_SCRIPT="120 clicksq e2; 140 clicksq e4; 300 shot /tmp/a.png; 300 fps; 310 quit"` | Scripted checks at frame numbers. @bloomengine/web's commands (`shot`, `click <selector>`, `clickat`, `key`, `type`, `focus`, `log`, `audio`, `fps`, `profile`, `quit`) and this app's (`hooks.ts`): `clicksq <square>` (a click through the app's own raycast), `move <uci>`, `select <square>`, `load <fen>`, `new white\|black`, `state` |
| `BLOOM_QUERY=theme=dino` | `location.search` (picks a theme) |

## Limits

- **Animation:** clips switch instead of crossfading, and the travel tilt during a hop isn't shown. Bloom's skinned draw takes position, yaw and scale.
- **Materials:** transparency and environment lighting come from Bloom, not three's materials.
- **Page:** see The menu for what the CSS engine doesn't draw. A `<select>` steps to its next option on each click.
