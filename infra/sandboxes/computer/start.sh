#!/usr/bin/env bash
set -uo pipefail
source /usr/local/lib/rakazo-user-env.sh
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/rakazo}"
AGENT_HOME="$HOME"
mkdir -p "$AGENT_HOME" "$AGENT_HOME/.local/bin" "$AGENT_HOME/.config" /tmp/rakazo /tmp/.X11-unix /tmp/fluxbox-home
# Login shells re-apply ~/.local/bin from /etc/profile.d/rakazo-local-bin.sh.
export PATH="$AGENT_HOME/.local/bin:/usr/local/bin:$PATH"
export NPM_CONFIG_PREFIX="$AGENT_HOME/.local"
export PIP_USER=1
cd "$AGENT_HOME"

# This script is PID 1, which ignores SIGTERM without a handler, so `docker stop` would wait out
# its grace period. Install the handler before any child starts so a stop during startup is
# honoured too.
XVFB_PID=""

# A browser that is killed by a signal does not commit its cookie jar and leaves a dirty
# exit_type, which makes the next start drop session cookies (account sign-in) while persistent
# cookies survive. The supervisor's stop path avoids this by closing each browser over CDP first;
# the shutdown this container performs itself must do the same, or a host reboot silently signs
# the user out.
#
# Mirrors the supervisor's own matching: a renderer inherits --user-data-dir but always carries
# --type=, and Browser.close reads --remote-debugging-port from the PID, so both flags are
# required. The lock is the fast path; the scan covers a lock that does not point at the process.
browser_matches() {
  local pid="$1" profile="$2" text
  case "$pid" in ''|0|*[!0-9]*) return 1 ;; esac
  [[ -e "/proc/$pid" ]] || return 1
  case "$(readlink "/proc/$pid/exe" 2>/dev/null || true)" in
    */bash|*/dash|*/sh|*/timeout) return 1 ;;
  esac
  text=" $(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true) "
  case "$text" in *" --user-data-dir=$profile "*) ;; *) return 1 ;; esac
  case "$text" in *" --remote-debugging-port="*) ;; *) return 1 ;; esac
  case "$text" in *" --type="*) return 1 ;; esac
  return 0
}

browser_pid_for_profile() {
  local profile="$1" pid dir
  pid=$(readlink "$profile/SingletonLock" 2>/dev/null || true)
  pid=${pid##*-}
  if browser_matches "$pid" "$profile"; then printf '%s\n' "$pid"; return 0; fi
  for dir in /proc/[0-9]*; do
    pid=${dir#/proc/}
    if browser_matches "$pid" "$profile"; then printf '%s\n' "$pid"; return 0; fi
  done
  return 1
}

flush_browsers() {
  local profile pid
  local -a browsers=()
  shopt -s nullglob
  # Ask every live browser to close first. Browser.close returns as soon as the browser accepts it,
  # so this pass is fast even with several profiles.
  for profile in "$AGENT_HOME"/.browser-profiles/chromium*; do
    [[ -d "$profile" ]] || continue
    pid=$(browser_pid_for_profile "$profile" || true)
    [[ -n "$pid" ]] || continue
    browsers+=("$pid")
    timeout 5 python3 /usr/local/bin/close-browser.py "$pid" "$profile" >/dev/null 2>&1 || true
  done
  shopt -u nullglob
  # Then let each one finish exiting before the blanket TERM below, which would otherwise interrupt
  # the very commit this exists to allow. One shared deadline keeps the shutdown inside Docker's
  # stop grace; Xvfb and the screen transports are not waited on, as they never exit on their own.
  local deadline=$((SECONDS + 8)) stragglers=""
  for pid in ${browsers[@]+"${browsers[@]}"}; do
    while [[ -e "/proc/$pid" && $SECONDS -lt $deadline ]]; do
      sleep 0.2
    done
    [[ -e "/proc/$pid" ]] && stragglers+=" $pid"
  done
  [[ -z "$stragglers" ]] || echo "browsers still up at shutdown:$stragglers" >&2
}

shutdown() {
  trap - TERM INT
  flush_browsers
  if [[ -n "$XVFB_PID" ]]; then
    kill -TERM "$XVFB_PID" 2>/dev/null || true
  fi
  kill -TERM -- -1 2>/dev/null || true
  if [[ -n "$XVFB_PID" ]]; then
    wait "$XVFB_PID" 2>/dev/null || true
  fi
  exit 0
}
trap shutdown TERM INT

if [[ -n "${RAKAZO_COMPUTER_CONTROL_TOKEN:-}" ]]; then
  while true; do
    /usr/local/bin/rakazo-computer-control
    sleep 1
  done >/tmp/rakazo/control.log 2>&1 &
fi

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1

Xvfb :1 -screen 0 1280x800x24 -ac +extension RANDR +render -noreset >/tmp/rakazo/xvfb.log 2>&1 &
XVFB_PID=$!

ready=0
for _ in $(seq 1 100); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" -ne 1 ]]; then
  echo "Xvfb failed to start" >&2
  cat /tmp/rakazo/xvfb.log >&2 || true
  exit 1
fi

if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
  # rakazo-browser is launched later without this session's environment; the
  # file-chooser portals only work if the browser finds the same bus.
  printf 'export DBUS_SESSION_BUS_ADDRESS=%s\n' "$DBUS_SESSION_BUS_ADDRESS" \
    > /tmp/rakazo/dbus-session
fi

# Chromium's file chooser talks to xdg-desktop-portal over the session bus.
# Without a running portal backend, the select-file dialog opens but the
# chosen file never reaches the page — uploads silently do nothing. The
# daemons install as flat files in /usr/libexec on Debian bookworm.
if [ -x /usr/libexec/xdg-desktop-portal ] && [ -x /usr/libexec/xdg-desktop-portal-gtk ]; then
  /usr/libexec/xdg-desktop-portal >/tmp/rakazo/portal.log 2>&1 &
  /usr/libexec/xdg-desktop-portal-gtk >/tmp/rakazo/portal-gtk.log 2>&1 &
fi

xsetroot -solid "#111113" >/dev/null 2>&1 || true
mkdir -p /tmp/fluxbox-home/.fluxbox
cp /etc/rakazo/fluxbox/init /tmp/fluxbox-home/.fluxbox/init
cp /etc/rakazo/fluxbox/apps /tmp/fluxbox-home/.fluxbox/apps 2>/dev/null || true
cp /etc/rakazo/fluxbox/menu /tmp/fluxbox-home/.fluxbox/menu 2>/dev/null || true
cat > /tmp/fluxbox-home/.fluxbox/startup <<'EOF'
#!/bin/sh
xsetroot -solid "#111113"
exec fluxbox -rc /tmp/fluxbox-home/.fluxbox/init
EOF
chmod +x /tmp/fluxbox-home/.fluxbox/startup
HOME=/tmp/fluxbox-home /tmp/fluxbox-home/.fluxbox/startup >/tmp/rakazo/fluxbox.log 2>&1 &

register_browser_handler() {
  local mime="$1"
  if ! xdg-mime default rakazo-browser.desktop "$mime" >/dev/null 2>&1 \
    || [[ "$(xdg-mime query default "$mime" 2>/dev/null || true)" != "rakazo-browser.desktop" ]]; then
    echo "failed to register rakazo-browser for $mime" >&2
    exit 1
  fi
}
register_browser_handler x-scheme-handler/http
register_browser_handler x-scheme-handler/https
register_browser_handler text/html
if ! xdg-settings set default-web-browser rakazo-browser.desktop >/dev/null 2>&1 \
  || [[ "$(xdg-settings get default-web-browser 2>/dev/null || true)" != "rakazo-browser.desktop" ]]; then
  echo "failed to set default web browser to rakazo-browser" >&2
  exit 1
fi

x11vnc -display :1 -forever -shared -viewonly -nopw -listen 127.0.0.1 -rfbport 5900 -xkb -ncache 0 >/tmp/rakazo/x11vnc.log 2>&1 &

NOVNC_ROOT=/usr/share/novnc
if [[ ! -d "$NOVNC_ROOT" ]]; then
  echo "noVNC is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/embed.html" ]]; then
  echo "noVNC embed.html is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/clipboard-bridge.js" ]]; then
  echo "noVNC clipboard-bridge.js is missing from the computer image" >&2
  exit 1
fi
if [[ ! -f "$NOVNC_ROOT/mobile-keyboard.js" ]]; then
  echo "noVNC mobile-keyboard.js is missing from the computer image" >&2
  exit 1
fi
# The screen proxy reaches this isolated container through its bridge interface.
websockify --heartbeat=30 --web="$NOVNC_ROOT" --token-plugin=TokenFile --token-source=/tmp/rakazo/view-target-1 0.0.0.0:6080 >/tmp/rakazo/novnc.log 2>&1 &

wait "$XVFB_PID"
echo "Xvfb exited" >&2
exit 1
