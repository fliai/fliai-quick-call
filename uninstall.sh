#!/bin/sh
# FLiAI Quick Call uninstaller for macOS and Linux. Run:
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

uninstall_mac() {
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

  return 0
}

uninstall_linux() {
  DIR="$HOME/.local/share/fliai-quick-call"

  # Stop it starting at login.
  AUTOSTART="${XDG_CONFIG_HOME:-$HOME/.config}/autostart/$NAME.desktop"
  if [ -f "$AUTOSTART" ]; then rm -f "$AUTOSTART"; ok "Removed start at login"; found=1; fi

  # Quit it.
  if pgrep -f "$DIR/fliai-quick-call" >/dev/null 2>&1; then
    pkill -f "$DIR/fliai-quick-call" 2>/dev/null || true
    sleep 1
    ok "Closed the app"; found=1
  fi

  # The app, its launcher and its menu entry.
  if [ -d "$DIR" ]; then
    rm -rf "$DIR" "$HOME/.local/bin/fliai-quick-call" "$HOME/.local/share/applications/fliai-quick-call.desktop"
    ok "Removed ~/.local/share/fliai-quick-call"; found=1
  fi

  # Settings (name, status, identity) and web view data.
  removed=
  for path in "${XDG_CONFIG_HOME:-$HOME/.config}/$ID" "${XDG_DATA_HOME:-$HOME/.local/share}/$ID" "${XDG_CACHE_HOME:-$HOME/.cache}/$ID" \
              "${TMPDIR:-/tmp}/fliai-quickcall-chime.wav"; do
    if [ -e "$path" ]; then rm -rf "$path"; removed=1; fi
  done
  [ -n "$removed" ] && { ok "Removed settings"; found=1; }
  return 0
}

case "$(uname -s)" in
  Darwin) uninstall_mac ;;
  Linux) uninstall_linux ;;
esac

if [ -n "$found" ]; then
  printf '\n  %sDone.%s FLiAI Quick Call is uninstalled.\n\n' "$G$B" "$N"
else
  skip "FLiAI Quick Call isn't installed."
  echo
fi
