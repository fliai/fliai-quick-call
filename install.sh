#!/bin/sh
# FLiAI Quick Call installer / updater for macOS. Run:
#   curl -fsSL https://cdn-quickcall.fliai.lk/install.sh | sh     (first install)
#   curl -fsSL https://cdn-quickcall.fliai.lk/update.sh | sh      (update; same script)
# Downloading with curl skips the macOS "unverified developer" warning.
set -e

BASE="https://cdn-quickcall.fliai.lk"
APP="FLiAI Quick Call.app"

DEST="/Applications"
[ -d "$DEST/$APP" ] || [ -w "$DEST" ] || DEST="$HOME/Applications"
[ -d "$DEST/$APP" ] || [ ! -d "$HOME/Applications/$APP" ] || DEST="$HOME/Applications"

latest=$(curl -fsSL "$BASE/latest.json" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')
installed=$(defaults read "$DEST/$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)
if [ -n "$latest" ] && [ "$latest" = "$installed" ]; then
  echo "FLiAI Quick Call $installed is already up to date."
  exit 0
fi

TMP=$(mktemp -d)
cleanup() { hdiutil detach -quiet "$TMP/mnt" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

if [ -n "$installed" ]; then
  echo "Updating FLiAI Quick Call $installed -> $latest..."
else
  echo "Installing FLiAI Quick Call $latest..."
fi
curl -fL --progress-bar -o "$TMP/app.dmg" "$BASE/fliai-quick-call.dmg"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$TMP/mnt" "$TMP/app.dmg"

mkdir -p "$DEST"
osascript -e 'quit app "FLiAI Quick Call"' >/dev/null 2>&1 || true
sleep 1
rm -rf "$DEST/$APP"
cp -R "$TMP/mnt/$APP" "$DEST/"
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true
open "$DEST/$APP"

echo "Done. Move your mouse to the top center of the screen to open it."
