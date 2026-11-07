#!/bin/sh
# Build the iPhone/iPad and Apple TV apps with Perry and Bloom (Metal).
#
#   sh web3d/bloom/build-ios.sh sim        simulator build, installed and launched on the booted simulator
#   sh web3d/bloom/build-ios.sh device     device build, signed for development, installed on the connected iPhone
#   sh web3d/bloom/build-ios.sh appstore   device build, signed for the App Store -> dist/ios/tuichess3d.ipa
#   sh web3d/bloom/build-ios.sh tv         Apple TV build, signed for development, installed on the paired Apple TV
#   sh web3d/bloom/build-ios.sh tvstore    Apple TV build, signed for the App Store -> dist/tvos/tuichess3d.ipa
#
# Settings (environment):
#   IOS_DEVICE        devicectl device id or name (default: the first connected iPhone, or Apple TV)
#   TEAM_ID           Apple team                       (default: [apple] team_id in ~/.perry/config.toml)
#   DEV_PROFILE       development .mobileprovision     (default: the team's profile for $BUNDLE_ID, or its * profile)
#   DEV_IDENTITY      development signing identity     (default: the keychain identity whose certificate is in the profile)
#   DIST_IDENTITY     distribution signing identity    (default: likewise)
#   DIST_PROFILE      App Store .mobileprovision for $BUNDLE_ID (required for appstore)
#   PERRY_IOS_LIBS    Perry's runtime/stdlib/UI libs for the target, when perry can't find them itself
#                     (a wrapper that sets PERRY_RUNTIME_DIR to the macOS libs hides them; see README.md)
#   PERRY_TVOS_LIBS   the same for tvOS (default: ~/projects/perry/worktrees/perry-tvos/target/aarch64-apple-tvos/release)
#   PERRY_NIGHTLY     the nightly toolchain Perry's tvOS libs were built with (default nightly-2026-10-04)
#   PERRY_FLAGS       more `perry compile` flags
#   SKIP_BUILD=1      package, sign and install the last build again without compiling
set -e
cd "$(dirname "$0")"
MODE="${1:-sim}"
BUNDLE_ID=$(sed -n 's/^bundle_id = "\(.*\)"/\1/p' perry.toml | head -1)
NAME=tuichess3d

case "$MODE" in
  sim) TARGET=ios-simulator; TRIPLE=aarch64-apple-ios-sim; OUT=dist/ios-sim; PLATFORM=iphonesimulator; OS=iOS ;;
  device|appstore) TARGET=ios; TRIPLE=aarch64-apple-ios; OUT=dist/ios; PLATFORM=iphoneos; OS=iOS ;;
  tv|tvstore) TARGET=tvos; TRIPLE=aarch64-apple-tvos; OUT=dist/tvos; PLATFORM=appletvos; OS=tvOS ;;
  *) echo "usage: build-ios.sh sim|device|appstore|tv|tvstore" >&2; exit 2 ;;
esac

# The web app's files go into the bundle: build.sh stages them in ./assets (stage-assets.sh), and
# Perry copies that into the .app (dom.ts finds them there).

# Perry's libraries for this target. A `perry` wrapper exporting PERRY_RUNTIME_DIR (pointing at the
# host's libs) would make the iOS link pick the macOS ones; point it at the target's libs instead.
if [ -z "$PERRY_IOS_LIBS" ]; then
  W=$(sed -n 's/^W=//p' "$(command -v perry)" 2>/dev/null || true)
  [ -n "$W" ] && [ -d "$W/../$TRIPLE/release" ] && PERRY_IOS_LIBS="$W/../$TRIPLE/release"
fi
if [ "$OS" = tvOS ]; then
  # tvOS is a tier-3 Rust target: Perry's libs come from a build with -Zbuild-std (README.md), and
  # Perry builds Bloom's tvOS lib with `cargo +nightly`; a cargo shim makes that the same nightly,
  # so the two share one std (or the link misses the allocator shims).
  PERRY_IOS_LIBS="${PERRY_TVOS_LIBS:-$HOME/projects/perry/worktrees/perry-tvos/target/aarch64-apple-tvos/release}"
  SHIM="$PWD/$OUT/cargo-shim"
  mkdir -p "$SHIM"
  cat > "$SHIM/cargo" <<'EOF'
#!/bin/bash
args=()
for a in "$@"; do [ "$a" = "+nightly" ] && a="+${PERRY_NIGHTLY:-nightly-2026-10-04}"; args+=("$a"); done
exec "$HOME/.cargo/bin/cargo" "${args[@]}"
EOF
  chmod +x "$SHIM/cargo"
  export PATH="$SHIM:$PATH"
fi
[ -n "$PERRY_IOS_LIBS" ] && export PERRY_RUNTIME_DIR="$PERRY_IOS_LIBS"

# --features ios-game-loop: UIKit gets the main thread, the app runs on its own (Bloom waits for UIKit).
# Device code is compiled for the A12, the oldest chip iOS 17 runs on: Perry otherwise emits RCpc
# loads (ldapr) and then assembles its stack maps for the A7, which rejects them. Apple TV: the
# A8 of the Apple TV HD, which tvOS still supports (Perry's tvOS path has no RCpc problem).
case "$TARGET" in ios) CPU="--march apple-a12" ;; tvos) CPU="--march apple-a8" ;; *) CPU="" ;; esac
if [ "$SKIP_BUILD" != 1 ]; then
  rm -rf "$OUT/$NAME.app"
  OUT="$OUT/$NAME" sh build.sh --target "$TARGET" --features ios-game-loop $CPU $PERRY_FLAGS
fi
APP="$OUT/$NAME.app"
[ -d "$APP" ] || { echo "no app bundle at $APP" >&2; exit 1; }

# App icon and launch screen color as an asset catalog (Assets.car): `perry compile` adds no icon,
# and App Store Connect wants a catalog with a 1024 px icon. iOS scales the one image to every size.
CAT="$OUT/Assets.xcassets"
rm -rf "$CAT" && mkdir -p "$CAT/AppIcon.appiconset" "$CAT/LaunchBackground.colorset"
if [ "$OS" = iOS ]; then cp icon.png "$CAT/AppIcon.appiconset/icon.png"; fi
cat > "$CAT/Contents.json" <<'EOF'
{ "info": { "author": "xcode", "version": 1 } }
EOF
cat > "$CAT/AppIcon.appiconset/Contents.json" <<'EOF'
{ "images": [ { "filename": "icon.png", "idiom": "universal", "platform": "ios", "size": "1024x1024" } ],
  "info": { "author": "xcode", "version": 1 } }
EOF
if [ "$OS" = tvOS ]; then
  # tvOS: a brand-assets set, the layered (parallax) icons from tvos/icon-back.png and
  # tvos/icon-front.png (1280x768, models/icon.py --back/--front) and the Top Shelf images from
  # tvos/topshelf-wide.png (4640x1440, models/icon.py --pieces), scaled and cropped here
  rm -rf "$CAT/AppIcon.appiconset"
  B="$CAT/App Icon & Top Shelf Image.brandassets"
  stack() {   # stack <name> <w> <h> <scales...>: an image stack with a back and a front layer
    S="$B/$1.imagestack"; mkdir -p "$S"
    echo '{ "layers": [ { "filename": "Front.imagestacklayer" }, { "filename": "Back.imagestacklayer" } ], "info": { "author": "xcode", "version": 1 } }' > "$S/Contents.json"
    for layer in Front Back; do
      L="$S/$layer.imagestacklayer"; mkdir -p "$L/Content.imageset"
      echo '{ "info": { "author": "xcode", "version": 1 } }' > "$L/Contents.json"
      src=tvos/icon-$(echo $layer | tr 'A-Z' 'a-z').png
      imgs=""
      for k in $4 $5; do
        sips -z $(($3 * k)) $(($2 * k)) "$src" --out "$L/Content.imageset/$layer@${k}x.png" >/dev/null
        imgs="$imgs{ \"filename\": \"$layer@${k}x.png\", \"idiom\": \"tv\", \"scale\": \"${k}x\" },"
      done
      echo "{ \"images\": [ ${imgs%,} ], \"info\": { \"author\": \"xcode\", \"version\": 1 } }" > "$L/Content.imageset/Contents.json"
    done
  }
  shelf() {   # shelf <name> <w> <h>: a Top Shelf image at 1x and 2x, cropped from the wide render's center
    I="$B/$1.imageset"; mkdir -p "$I"
    for k in 1 2; do
      w=$(($2 * k)); h=$(($3 * k))
      sips -z $h $((4640 * h / 1440)) tvos/topshelf-wide.png --out "$I/tmp.png" >/dev/null
      sips -c $h $w "$I/tmp.png" --out "$I/$1@${k}x.png" >/dev/null
    done
    rm -f "$I/tmp.png"
    echo "{ \"images\": [ { \"filename\": \"$1@1x.png\", \"idiom\": \"tv\", \"scale\": \"1x\" }, { \"filename\": \"$1@2x.png\", \"idiom\": \"tv\", \"scale\": \"2x\" } ], \"info\": { \"author\": \"xcode\", \"version\": 1 } }" > "$I/Contents.json"
  }
  stack "App Icon" 400 240 1 2
  stack "App Icon - App Store" 1280 768 1
  shelf "Top Shelf Image" 1920 720
  shelf "Top Shelf Image Wide" 2320 720
  cat > "$B/Contents.json" <<'EOF'
{ "assets": [
    { "filename": "App Icon - App Store.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "1280x768" },
    { "filename": "App Icon.imagestack", "idiom": "tv", "role": "primary-app-icon", "size": "400x240" },
    { "filename": "Top Shelf Image Wide.imageset", "idiom": "tv", "role": "top-shelf-image-wide", "size": "2320x720" },
    { "filename": "Top Shelf Image.imageset", "idiom": "tv", "role": "top-shelf-image", "size": "1920x720" } ],
  "info": { "author": "xcode", "version": 1 } }
EOF
fi
cat > "$CAT/LaunchBackground.colorset/Contents.json" <<'EOF'
{ "colors": [ { "idiom": "universal", "color": { "color-space": "srgb",
    "components": { "red": "0x0F", "green": "0x10", "blue": "0x12", "alpha": "1.000" } } } ],
  "info": { "author": "xcode", "version": 1 } }
EOF
if [ "$OS" = tvOS ]; then DEVICES="--target-device tv"; ICON="App Icon & Top Shelf Image"; else DEVICES="--target-device iphone --target-device ipad"; ICON=AppIcon; fi
xcrun actool "$CAT" --compile "$APP" --platform "$PLATFORM" --minimum-deployment-target 17.0 \
  $DEVICES --app-icon "$ICON" \
  --output-partial-info-plist "$OUT/assets-info.plist" --output-format human-readable-text --notices --warnings > "$OUT/actool.log" \
  || { [ "$MODE" != appstore ] && [ "$MODE" != tvstore ]; } \
  || { cat "$OUT/actool.log" >&2; echo "actool failed: Xcode needs the simulator runtime of its iOS SDK (xcodebuild -downloadPlatform iOS)" >&2; exit 1; }
# (without that runtime actool still writes PNG icons, which do for development installs)
# the icon keys actool wants (CFBundleIcons with CFBundleIconName), then the dark launch screen
/usr/libexec/PlistBuddy -c "Delete :CFBundleIcons" "$APP/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :CFBundleIcons~ipad" "$APP/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :TVTopShelfImage" "$APP/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Merge $OUT/assets-info.plist" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :UILaunchScreen" "$APP/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :UILaunchScreen dict" -c "Add :UILaunchScreen:UIColorName string LaunchBackground" \
  "$APP/Info.plist"
# identity and export compliance from perry.toml's [project], whatever Perry's per-target defaults are
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $BUNDLE_ID" "$APP/Info.plist"
/usr/libexec/PlistBuddy -c "Delete :ITSAppUsesNonExemptEncryption" "$APP/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :ITSAppUsesNonExemptEncryption bool false" "$APP/Info.plist"
# a 64-bit binary must say so (App Store Connect error 90502); Perry's tvOS plist leaves it out
/usr/libexec/PlistBuddy -c "Delete :UIRequiredDeviceCapabilities" "$APP/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :UIRequiredDeviceCapabilities array" -c "Add :UIRequiredDeviceCapabilities:0 string arm64" "$APP/Info.plist"
if [ "$OS" = iOS ]; then
  /usr/libexec/PlistBuddy -c "Add :UIStatusBarHidden bool true" "$APP/Info.plist" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :UIRequiresFullScreen bool true" "$APP/Info.plist" 2>/dev/null || true
fi
# Perry's template asks for the camera and microphone; this app uses neither (no capture or
# recording APIs in the binary), and App Review rejects purpose strings that don't fit the app.
/usr/libexec/PlistBuddy -c "Delete :NSCameraUsageDescription" "$APP/Info.plist" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Delete :NSMicrophoneUsageDescription" "$APP/Info.plist" 2>/dev/null || true

# Privacy manifest: no tracking, no data collected. The "required reason" APIs the binary calls are
# file status (stat/fstat/lstat: the app's own files, C617.1) and mach_absolute_time (frame timing,
# 35F9.1); App Store Connect rejects an upload that uses them undeclared.
cat > "$APP/PrivacyInfo.xcprivacy" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSPrivacyTracking</key><false/>
  <key>NSPrivacyTrackingDomains</key><array/>
  <key>NSPrivacyCollectedDataTypes</key><array/>
  <key>NSPrivacyAccessedAPITypes</key>
  <array>
    <dict>
      <key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategoryFileTimestamp</string>
      <key>NSPrivacyAccessedAPITypeReasons</key><array><string>C617.1</string></array>
    </dict>
    <dict>
      <key>NSPrivacyAccessedAPIType</key><string>NSPrivacyAccessedAPICategorySystemBootTime</string>
      <key>NSPrivacyAccessedAPITypeReasons</key><array><string>35F9.1</string></array>
    </dict>
  </array>
</dict>
</plist>
EOF
plutil -lint -s "$APP/PrivacyInfo.xcprivacy"

profile_plist() { security cms -D -i "$1"; }
TEAM_ID="${TEAM_ID:-$(sed -n 's/^team_id = "\(.*\)"/\1/p' "$HOME/.perry/config.toml" 2>/dev/null | head -1)}"

# the keychain identity (SHA-1) whose certificate the profile lists
identity_for() {   # identity_for <profile>
  ids=$(security find-identity -v -p codesigning | awk '{print $2}')
  i=0
  while profile_plist "$1" | plutil -extract "DeveloperCertificates.$i" raw - > "$OUT/cert.b64" 2>/dev/null; do
    sha=$(base64 -d -i "$OUT/cert.b64" | shasum -a 1 | awk '{print toupper($1)}')
    if echo "$ids" | grep -q "^$sha$"; then echo "$sha"; return; fi
    i=$((i + 1))
  done
}

sign() {   # sign <identity> <profile> <get-task-allow true|false>
  cp "$2" "$APP/embedded.mobileprovision"
  TEAM=$(profile_plist "$2" | plutil -extract TeamIdentifier.0 raw -)
  cat > "$OUT/entitlements.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>application-identifier</key><string>$TEAM.$BUNDLE_ID</string>
  <key>com.apple.developer.team-identifier</key><string>$TEAM</string>
  <key>get-task-allow</key><$3/>
</dict></plist>
EOF
  codesign --force --sign "$1" --entitlements "$OUT/entitlements.plist" --timestamp=none --generate-entitlement-der "$APP"
  codesign --verify --strict "$APP"
}

# the first installed profile of the given kind that covers the bundle id (exact, then team wildcard)
find_profile() {   # find_profile development|appstore
  best=""
  for f in "$HOME/Library/Developer/Xcode/UserData/Provisioning Profiles"/*.mobileprovision "$HOME/Library/MobileDevice/Provisioning Profiles"/*.mobileprovision "$HOME"/.perry/*.mobileprovision; do
    [ -f "$f" ] || continue
    p=$(profile_plist "$f" 2>/dev/null) || continue
    app=$(echo "$p" | plutil -extract Entitlements.application-identifier raw - 2>/dev/null) || continue
    case "$app" in "$TEAM_ID".*) ;; *) continue ;; esac
    echo "$p" | plutil -extract Platform json -o - - 2>/dev/null | grep -q "\"$OS\"" || continue
    exp=$(echo "$p" | plutil -extract ExpirationDate raw - 2>/dev/null)
    [ "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \< "$exp" ] || continue
    devices=$(echo "$p" | plutil -extract ProvisionedDevices raw - >/dev/null 2>&1 && echo yes || echo no)
    if [ "$1" = development ] && [ "$devices" = no ]; then continue; fi
    if [ "$1" = appstore ] && [ "$devices" = yes ]; then continue; fi
    case "$app" in
      *."$BUNDLE_ID") echo "$f"; return ;;
      *.\*) [ "$1" = development ] && [ -z "$best" ] && best="$f" ;;   # App Store profiles name the app
    esac
  done
  echo "$best"
}

case "$MODE" in
  sim)
    xcrun simctl install booted "$APP"
    xcrun simctl launch booted "$BUNDLE_ID"
    ;;
  device|tv)
    PROFILE="${DEV_PROFILE:-$(find_profile development)}"
    [ -n "$PROFILE" ] || { echo "no development profile for $BUNDLE_ID (set DEV_PROFILE)" >&2; exit 1; }
    IDENTITY="${DEV_IDENTITY:-$(identity_for "$PROFILE")}"
    [ -n "$IDENTITY" ] || { echo "no keychain identity for a certificate in $PROFILE (set DEV_IDENTITY)" >&2; exit 1; }
    echo "signing with $IDENTITY, profile $PROFILE"
    sign "$IDENTITY" "$PROFILE" true
    [ "$OS" = tvOS ] && KIND="apple tv" || KIND="iphone"
    DEVICE="${IOS_DEVICE:-$(xcrun devicectl list devices 2>/dev/null | grep "available (paired)" | grep -i "$KIND" | head -1 | awk '{for (i=1;i<=NF;i++) if ($i ~ /^[0-9A-F]{8}-/) {print $i; exit}}')}"
    [ -n "$DEVICE" ] || { echo "no connected $KIND (set IOS_DEVICE)" >&2; exit 1; }
    xcrun devicectl device install app --device "$DEVICE" "$APP"
    xcrun devicectl device process launch --device "$DEVICE" "$BUNDLE_ID"
    ;;
  appstore|tvstore)
    PROFILE="${DIST_PROFILE:-$(find_profile appstore)}"
    [ -n "$PROFILE" ] || { echo "no App Store profile for $BUNDLE_ID (set DIST_PROFILE)" >&2; exit 1; }
    IDENTITY="${DIST_IDENTITY:-$(identity_for "$PROFILE")}"
    [ -n "$IDENTITY" ] || { echo "no keychain identity for a certificate in $PROFILE (set DIST_IDENTITY)" >&2; exit 1; }
    echo "signing with $IDENTITY, profile $PROFILE"
    sign "$IDENTITY" "$PROFILE" false
    rm -rf "$OUT/Payload" "$OUT/$NAME.ipa"
    mkdir -p "$OUT/Payload" && cp -R "$APP" "$OUT/Payload/"
    (cd "$OUT" && zip -qry "$NAME.ipa" Payload) && rm -rf "$OUT/Payload"
    echo "$OUT/$NAME.ipa"
    ;;
esac
