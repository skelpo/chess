#!/bin/sh
# Build the Mac app (Apple silicon) with Perry and Bloom, as an App Store bundle.
#
#   sh web3d/bloom/build-macos.sh            dist/macos/tuichess 3D.app, sandboxed, signed ad hoc: runs here
#   sh web3d/bloom/build-macos.sh appstore   the same, signed for the Mac App Store -> dist/macos/tuichess3d.pkg
#
# Settings (environment):
#   SKIP_BUILD=1      bundle and sign the last build again without compiling
#   MIN_MACOS         oldest macOS the app runs on (default 13.0)
#   TEAM_ID           Apple team (default: [apple] team_id in ~/.perry/config.toml)
#   MAS_PROFILE       Mac App Store .provisionprofile (default: ~/.perry/com_skelpo_tuichess_macos.provisionprofile)
#   MAS_IDENTITY      app signing identity       (default: "3rd Party Mac Developer Application: ..." in the keychain)
#   MAS_INSTALLER     installer signing identity (default: "3rd Party Mac Developer Installer: ..." in the keychain)
set -e
cd "$(dirname "$0")"
MODE="${1:-local}"
BUNDLE_ID=$(sed -n 's/^bundle_id = "\(.*\)"/\1/p' perry.toml | head -1)
NAME=$(sed -n 's/^display_name = "\(.*\)"/\1/p' perry.toml | head -1)
VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' perry.toml | head -1)
BUILD=$(sed -n 's/^build_number = \(.*\)/\1/p' perry.toml | head -1)
EXE=tuichess3d
OUT=dist/macos
APP="$OUT/$NAME.app"
TEAM_ID="${TEAM_ID:-$(sed -n 's/^team_id = "\(.*\)"/\1/p' "$HOME/.perry/config.toml" 2>/dev/null | head -1)}"
MIN_MACOS="${MIN_MACOS:-13.0}"

# 1. the binary. MACOSX_DEPLOYMENT_TARGET: clang and cargo otherwise build for this Mac's macOS.
if [ "$SKIP_BUILD" != 1 ]; then
  MACOSX_DEPLOYMENT_TARGET="$MIN_MACOS" OUT="$OUT/$EXE" sh build.sh
fi
[ -f "$OUT/$EXE" ] || { echo "no binary at $OUT/$EXE" >&2; exit 1; }

# 2. the bundle: the binary, the web app's files (dom.ts finds them in Contents/Resources/assets/web3d)
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/assets"
cp "$OUT/$EXE" "$APP/Contents/MacOS/$EXE"
[ "$SKIP_BUILD" != 1 ] || sh stage-assets.sh    # build.sh stages them otherwise
cp -R assets/web3d "$APP/Contents/Resources/assets/"

# icon: an asset catalog (and the .icns actool makes from it) from icon-mac.png, which has the
# macOS shape (rounded square on Apple's 824/1024 grid, with a shadow) drawn in
CAT="$OUT/Assets.xcassets"
rm -rf "$CAT" && mkdir -p "$CAT/AppIcon.appiconset"
echo '{ "info": { "author": "xcode", "version": 1 } }' > "$CAT/Contents.json"
images=""
for s in 16 32 128 256 512; do
  for k in 1 2; do
    px=$((s * k)); f="icon_${s}x${s}@${k}x.png"
    sips -z $px $px icon-mac.png --out "$CAT/AppIcon.appiconset/$f" >/dev/null
    images="$images{ \"filename\": \"$f\", \"idiom\": \"mac\", \"scale\": \"${k}x\", \"size\": \"${s}x${s}\" },"
  done
done
echo "{ \"images\": [ ${images%,} ], \"info\": { \"author\": \"xcode\", \"version\": 1 } }" > "$CAT/AppIcon.appiconset/Contents.json"
xcrun actool "$CAT" --compile "$APP/Contents/Resources" --platform macosx --minimum-deployment-target "$MIN_MACOS" \
  --app-icon AppIcon --output-partial-info-plist "$OUT/assets-info.plist" --output-format human-readable-text > "$OUT/actool.log" \
  || { cat "$OUT/actool.log" >&2; exit 1; }

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>en</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID</string>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>$EXE</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$BUILD</string>
  <key>CFBundleSupportedPlatforms</key><array><string>MacOSX</string></array>
  <key>LSMinimumSystemVersion</key><string>$MIN_MACOS</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.board-games</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>© 2026 skelpo GmbH</string>
  <key>ITSAppUsesNonExemptEncryption</key><false/>
</dict>
</plist>
EOF
/usr/libexec/PlistBuddy -c "Merge $OUT/assets-info.plist" "$APP/Contents/Info.plist"
plutil -lint -s "$APP/Contents/Info.plist"

# privacy manifest: no tracking, no data collected; file status and frame timing are the
# "required reason" APIs the binary calls (see build-ios.sh)
cat > "$APP/Contents/Resources/PrivacyInfo.xcprivacy" <<'EOF'
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

# 3. sign. The App Store requires the sandbox; the local build gets it too, so it behaves the same
# (its files and saved games live in ~/Library/Containers/$BUNDLE_ID).
ENT="$OUT/entitlements.plist"
if [ "$MODE" = appstore ]; then
  PROFILE="${MAS_PROFILE:-$HOME/.perry/com_skelpo_tuichess_macos.provisionprofile}"
  IDENTITY="${MAS_IDENTITY:-$(security find-identity -v -p codesigning | sed -n 's/.*"\(3rd Party Mac Developer Application: [^"]*\)".*/\1/p' | head -1)}"
  INSTALLER="${MAS_INSTALLER:-$(security find-identity -v | sed -n 's/.*"\(3rd Party Mac Developer Installer: [^"]*\)".*/\1/p' | head -1)}"
  cp "$PROFILE" "$APP/Contents/embedded.provisionprofile"
  cat > "$ENT" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
  <key>com.apple.application-identifier</key><string>$TEAM_ID.$BUNDLE_ID</string>
  <key>com.apple.developer.team-identifier</key><string>$TEAM_ID</string>
</dict></plist>
EOF
  codesign --force --options runtime --timestamp --sign "$IDENTITY" --entitlements "$ENT" "$APP"
  codesign --verify --strict --deep "$APP"
  rm -f "$OUT/$EXE.pkg"
  productbuild --component "$APP" /Applications --sign "$INSTALLER" "$OUT/$EXE.pkg"
  echo "$OUT/$EXE.pkg"
else
  cat > "$ENT" <<'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.app-sandbox</key><true/>
</dict></plist>
EOF
  codesign --force --sign - --entitlements "$ENT" "$APP"
  echo "$APP"
fi
