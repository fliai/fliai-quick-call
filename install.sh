#!/bin/sh
# FLiAI Quick Call installer for macOS. Run:
#   curl -fsSL https://cdn-quickcall.fliai.lk/install.sh | sh
# Downloading with curl skips the macOS "unverified developer" warning.
set -e

BASE="https://cdn-quickcall.fliai.lk"
APP="FLiAI Quick Call.app"

TMP=$(mktemp -d)
cleanup() { hdiutil detach -quiet "$TMP/mnt" 2>/dev/null || true; rm -rf "$TMP"; }
trap cleanup EXIT

echo "Downloading FLiAI Quick Call..."
curl -fL --progress-bar -o "$TMP/app.dmg" "$BASE/fliai-quick-call.dmg"
hdiutil attach -quiet -nobrowse -readonly -mountpoint "$TMP/mnt" "$TMP/app.dmg"

DEST="/Applications"
[ -w "$DEST" ] || { DEST="$HOME/Applications"; mkdir -p "$DEST"; }

osascript -e 'quit app "FLiAI Quick Call"' >/dev/null 2>&1 || true
rm -rf "$DEST/$APP"
cp -R "$TMP/mnt/$APP" "$DEST/"
xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true
open "$DEST/$APP"

echo "Installed to $DEST. Move your mouse to the top center of the screen to open it."
