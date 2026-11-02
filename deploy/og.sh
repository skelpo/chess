#!/bin/sh
# Renders deploy/og.html into site/og.png (1200x630), the social preview image. Needs Google Chrome.
set -eu
cd "$(dirname "$0")/.."
CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=1200,630 \
  --virtual-time-budget=8000 --screenshot="$PWD/site/og.png" "file://$PWD/deploy/og.html" >/dev/null 2>&1
ls -l site/og.png
