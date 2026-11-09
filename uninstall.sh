#!/bin/sh
# FLiAI Quick Call uninstaller for macOS. Run:
#   curl -fsSL https://cdn-quickcall.fliai.lk/uninstall.sh | sh
# Quits the app, stops it starting at login, and removes the app and its settings.
set -e

APP="FLiAI Quick Call.app"
NAME="FLiAI Quick Call"
ID="lk.fliai.quickcall"

if [ -t 1 ]; then
  B=$(printf '\033[1m'); D=$(printf '\033[2m'); G=$(printf '\033[32m'); N=$(printf '\033[0m')
else
  B=; D=; G=; N=
fi
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
skip() { printf '  %s–  %s%s\n' "$D" "$1" "$N"; }

printf '\n  %sFLiAI Quick Call%s\n\n' "$B" "$N"
found=

# Stop it starting at login first: the login item restarts the app if it's killed.
removed_agent=
for AGENT in "$HOME/Library/LaunchAgents/$ID.plist" "$HOME/Library/LaunchAgents/$NAME.plist"; do
  if [ -f "$AGENT" ]; then
    launchctl unload "$AGENT" >/dev/null 2>&1 || true
    rm -f "$AGENT"
    removed_agent=1
  fi
done
[ -n "$removed_agent" ] && { ok "Removed start at login"; found=1; }

# Quit it (and any test copies).
if pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; then
  osascript -e "quit app \"$NAME\"" >/dev/null 2>&1 || true
  sleep 1
  pkill -f "$APP/Contents/MacOS" 2>/dev/null || true
  ok "Closed the app"; found=1
fi

# The app itself.
for dir in /Applications "$HOME/Applications"; do
  if [ -d "$dir/$APP" ]; then
    rm -rf "$dir/$APP"
    ok "Removed $dir/$APP"; found=1
  fi
done

# Settings (name, status, identity) and web view data.
removed=
for path in "$HOME/Library/Application Support/$ID" "$HOME/Library/Caches/$ID" "$HOME/Library/WebKit/$ID" \
            "$HOME/Library/Saved Application State/$ID.savedState" "${TMPDIR:-/tmp}/fliai-quickcall-chime.wav"; do
  if [ -e "$path" ]; then rm -rf "$path"; removed=1; fi
done
[ -n "$removed" ] && { ok "Removed settings"; found=1; }

if [ -n "$found" ]; then
  printf '\n  %sDone.%s FLiAI Quick Call is uninstalled.\n\n' "$G$B" "$N"
else
  skip "FLiAI Quick Call isn't installed."
  echo
fi
