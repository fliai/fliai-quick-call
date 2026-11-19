#!/bin/sh
# FLiAI Quick Call installer / updater for macOS and Linux. Run:
#   curl -fsSL https://cdn-quickcall.fliai.lk/install.sh | sh     (first install)
#   curl -fsSL https://cdn-quickcall.fliai.lk/update.sh | sh      (update; same script)
# Downloading with curl skips the macOS "unverified developer" warning.
# Linux installs into your home folder (no sudo), so the app can update itself.
set -e

BASE="https://cdn-quickcall.fliai.lk"
APP="FLiAI Quick Call.app"

# ---------- pretty output (plain when not a terminal) ----------
if [ -t 1 ]; then
  B=$(printf '\033[1m'); D=$(printf '\033[2m'); G=$(printf '\033[32m'); C=$(printf '\033[36m')
  R=$(printf '\033[31m'); N=$(printf '\033[0m'); TTY=1
else
  B=; D=; G=; C=; R=; N=; TTY=
fi
ok()   { printf '  %s✓%s %s\n' "$G" "$N" "$1"; }
fail() { printf '  %s✗ %s%s\n' "$R" "$1" "$N" >&2; exit 1; }
mb()   { awk -v b="$1" 'BEGIN { printf "%.1f MB", b / 1048576 }'; }

# Run a command with a spinner; print a ✓ line when it finishes.
step() {
  label=$1; shift
  if [ -z "$TTY" ]; then "$@" || fail "$label failed"; ok "$label"; return; fi
  "$@" >/dev/null 2>&1 & pid=$!
  i=0
  while kill -0 "$pid" 2>/dev/null; do
    case $((i % 10)) in 0) f=⠋;; 1) f=⠙;; 2) f=⠹;; 3) f=⠸;; 4) f=⠼;; 5) f=⠴;; 6) f=⠦;; 7) f=⠧;; 8) f=⠇;; *) f=⠏;; esac
    printf '\r  %s%s%s %s' "$C" "$f" "$N" "$label"
    i=$((i + 1)); sleep 0.08
  done
  wait "$pid" || { printf '\r\033[K'; fail "$label failed"; }
  printf '\r\033[K'; ok "$label"
}

# Download $1 to $2 with a live progress bar: ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━  62%  18.4 / 29.7 MB  4.2 MB/s
download() {
  url=$1; out=$2
  if [ -z "$TTY" ]; then curl -fsSL -o "$out" "$url" || fail "Download failed"; ok "Downloaded"; return; fi
  total=$(curl -fsSLI "$url" | tr -d '\r' | awk 'tolower($1) == "content-length:" { n = $2 } END { print n + 0 }')
  : > "$out"
  curl -fsSL -o "$out" "$url" & pid=$!
  start=$(date +%s)
  while kill -0 "$pid" 2>/dev/null; do
    now=$(wc -c < "$out" | tr -d ' ')
    awk -v n="$now" -v t="$total" -v s="$(( $(date +%s) - start ))" -v c="$C" -v d="$D" -v x="$N" 'BEGIN {
      w = 30; sp = (s > 0) ? n / s : 0
      if (t > 0) {
        p = n / t; if (p > 1) p = 1; f = int(p * w)
        bar = c; for (i = 0; i < f; i++) bar = bar "━"; bar = bar d; for (; i < w; i++) bar = bar "━"; bar = bar x
        printf "\r  %s %3d%%  %s%.1f / %.1f MB  %.1f MB/s%s\033[K", bar, p * 100, d, n / 1048576, t / 1048576, sp / 1048576, x
      } else {
        printf "\r  %sDownloading%s  %s%.1f MB  %.1f MB/s%s\033[K", c, x, d, n / 1048576, sp / 1048576, x
      }
    }'
    sleep 0.1
  done
  wait "$pid" || { printf '\r\033[K'; fail "Download failed. Check your internet connection and try again."; }
  printf '\r\033[K'; ok "Downloaded $(mb "$(wc -c < "$out" | tr -d ' ')")"
}

# ---------- install ----------
latest=$(curl -fsSL "$BASE/latest.json" | sed -n 's/.*"version":"\([^"]*\)".*/\1/p')

header() {
  printf '\n  %sFLiAI Quick Call%s\n\n' "$B" "$N"
  if [ -n "$latest" ] && [ "$latest" = "$installed" ]; then
    ok "FLiAI Quick Call $installed is already up to date."
    echo
    exit 0
  fi
}

intro() {
  if [ -n "$installed" ]; then
    printf '  Updating %s%s%s → %s%s%s\n\n' "$D" "$installed" "$N" "$G" "$latest" "$N"
  else
    printf '  Installing version %s%s%s\n\n' "$G" "$latest" "$N"
  fi
}

# If the app was closed for an update (by this script, or by the app itself before running it)
# and something then failed, reopen whatever version is installed so nobody is left without it.
reopen_if_needed() {
  [ -n "$QC_REOPEN$closed" ] || return 0
  is_running && return 0
  start_app >/dev/null 2>&1 || true
}

install_mac() {
  DEST="/Applications"
  [ -d "$DEST/$APP" ] || [ -w "$DEST" ] || DEST="$HOME/Applications"
  [ -d "$DEST/$APP" ] || [ ! -d "$HOME/Applications/$APP" ] || DEST="$HOME/Applications"
  installed=$(defaults read "$DEST/$APP/Contents/Info" CFBundleShortVersionString 2>/dev/null || true)
  is_running() { pgrep -f "$APP/Contents/MacOS" >/dev/null 2>&1; }
  start_app() { [ -d "$DEST/$APP" ] && open "$DEST/$APP"; }
  header

  TMP=$(mktemp -d)
  cleanup() { hdiutil detach -quiet "$TMP/mnt" 2>/dev/null || true; rm -rf "$TMP"; reopen_if_needed; }
  trap cleanup EXIT
  intro

  download "$BASE/fliai-quick-call.dmg" "$TMP/app.dmg"
  step "Unpacking" hdiutil attach -quiet -nobrowse -readonly -mountpoint "$TMP/mnt" "$TMP/app.dmg"

  mkdir -p "$DEST"
  quit_app() { osascript -e 'quit app "FLiAI Quick Call"' || true; sleep 1; }
  if [ -n "$installed" ]; then closed=1; step "Closing the running app" quit_app; fi

  copy_app() { rm -rf "$DEST/$APP" && cp -R "$TMP/mnt/$APP" "$DEST/" && { xattr -dr com.apple.quarantine "$DEST/$APP" 2>/dev/null || true; }; }
  step "Installing to $DEST" copy_app
  step "Starting FLiAI Quick Call" open "$DEST/$APP"

  printf '\n  %sDone!%s Move your mouse to the top center of the screen to open it.\n' "$G$B" "$N"
  printf '  %sIt starts by itself when you log in.%s\n\n' "$D" "$N"
}

install_linux() {
  case "$(uname -m)" in x86_64|amd64) ;; *) printf '\n'; fail "The Linux version is for 64-bit Intel/AMD PCs (x86_64) only.";; esac
  DIR="$HOME/.local/share/fliai-quick-call"
  BIN="$DIR/fliai-quick-call"
  installed=$(cat "$DIR/VERSION" 2>/dev/null || true)
  is_running() { pgrep -f "$BIN" >/dev/null 2>&1; }
  start_app() { [ -x "$BIN" ] && [ -n "$DISPLAY$WAYLAND_DISPLAY" ] && { setsid "$BIN" >/dev/null 2>&1 < /dev/null & }; }
  header

  # The one thing it needs from the system: the web view library (on most Ubuntu desktops already).
  if ! { /sbin/ldconfig -p 2>/dev/null || ldconfig -p 2>/dev/null; } | grep -q 'libwebkit2gtk-4\.1\.so\.0'; then
    printf '  %sFLiAI Quick Call needs the WebKitGTK web view. Install it with:%s\n\n' "$R" "$N"
    printf '    sudo apt install libwebkit2gtk-4.1-0\n\n'
    printf '  then run this command again.\n\n'
    exit 1
  fi

  TMP=$(mktemp -d)
  cleanup() { rm -rf "$TMP"; reopen_if_needed; }
  trap cleanup EXIT
  intro

  download "$BASE/fliai-quick-call-linux-x86_64.tar.gz" "$TMP/app.tar.gz"
  step "Unpacking" tar -xzf "$TMP/app.tar.gz" -C "$TMP"

  stop_app() { pkill -f "$BIN" 2>/dev/null || true; sleep 1; }
  if is_running; then closed=1; step "Closing the running app" stop_app; fi

  place() {
    mkdir -p "$DIR" "$HOME/.local/bin" "$HOME/.local/share/applications" &&
    install -m 755 "$TMP/fliai-quick-call" "$BIN.new" && mv -f "$BIN.new" "$BIN" &&
    install -m 644 "$TMP/icon.png" "$DIR/icon.png" &&
    ln -sf "$BIN" "$HOME/.local/bin/fliai-quick-call" &&
    printf '[Desktop Entry]\nType=Application\nName=FLiAI Quick Call\nComment=Tap a teammate on the shoulder over the office network\nExec=%s\nIcon=%s\nCategories=Office;Network;\nTerminal=false\n' "$BIN" "$DIR/icon.png" > "$HOME/.local/share/applications/fliai-quick-call.desktop" &&
    printf '%s\n' "$latest" > "$DIR/VERSION"
  }
  step "Installing to ~/.local/share/fliai-quick-call" place

  if [ -n "$DISPLAY$WAYLAND_DISPLAY" ]; then
    step "Starting FLiAI Quick Call" start_app
    printf '\n  %sDone!%s Move your mouse to the top center of the screen to open it.\n' "$G$B" "$N"
  else
    printf '\n  %sDone!%s Open FLiAI Quick Call from your apps menu.\n' "$G$B" "$N"
  fi
  printf '  %sIt starts by itself when you log in.%s\n\n' "$D" "$N"
}

case "$(uname -s)" in
  Darwin) install_mac ;;
  Linux) install_linux ;;
  *) printf '\n'; fail "FLiAI Quick Call runs on macOS, Windows and Linux. On Windows, use the PowerShell command." ;;
esac
