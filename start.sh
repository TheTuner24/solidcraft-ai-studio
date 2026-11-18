#!/usr/bin/env bash
# Startet SolidCraft (falls nötig), die USB-Weiterleitung zum Tablet und das Studio.
# Aus dem Startmenü (ohne Terminal) gehen Meldungen als Benachrichtigung und ins Protokoll
# ~/CAD/ai-studio/.cache/studio.log. Wird SolidCraft geschlossen, beendet sich das Studio mit.
set -euo pipefail
cd "$(dirname "$0")"

CONTROL_PORT="${CONTROL_PORT:-7979}"
STUDIO_PORT="${STUDIO_PORT:-8765}"
CONTROL_DIR="$HOME/.local/share/solidcraft/control"
CACHE="$HOME/CAD/ai-studio/.cache"
URL_FILE="$CACHE/studio-url.txt"
mkdir -p "$CACHE"

if [ -t 1 ]; then
  say() { echo "$*"; }
else
  exec >>"$CACHE/studio.log" 2>&1
  say() { echo "$(date +%T) $*"; command -v notify-send >/dev/null && notify-send -a "SolidCraft AI Studio" -i "$HOME/.local/share/icons/solidcraft-ai-studio.png" "SolidCraft AI Studio" "$*" || true; }
fi
port_open() { (exec 3<>/dev/tcp/127.0.0.1/"$1") 2>/dev/null; }

ADB="$(command -v adb || echo "$HOME/Android/Sdk/platform-tools/adb")"
tablet() { [ -x "$ADB" ] && "$ADB" get-state >/dev/null 2>&1; }
open_on_tablet() {
  [ -s "$URL_FILE" ] || return 0
  if tablet; then
    "$ADB" reverse "tcp:$STUDIO_PORT" "tcp:$STUDIO_PORT" >/dev/null
    "$ADB" shell am start -a android.intent.action.VIEW -d "$(cat "$URL_FILE")" org.mozilla.firefox >/dev/null 2>&1 \
      && say "Studio auf dem Tablet geöffnet." \
      || say "Firefox auf dem Tablet nicht gefunden. Link: $(cat "$URL_FILE")"
  else
    say "Kein Tablet per USB (USB-Debugging an?). Am PC: $(cat "$URL_FILE")"
  fi
}

# SolidCraft mit Steuerkanal
APP_PID=""
if ! port_open "$CONTROL_PORT"; then
  say "Starte SolidCraft …"
  solidcraft --control "$CONTROL_PORT" >"$CACHE/solidcraft.log" 2>&1 &
  APP_PID=$!
  for _ in $(seq 1 60); do
    [ -s "$CONTROL_DIR/$CONTROL_PORT.token" ] && port_open "$CONTROL_PORT" && break
    sleep 0.5
  done
fi

# Studio läuft schon: nur das Tablet neu verbinden.
if port_open "$STUDIO_PORT"; then
  open_on_tablet
  exit 0
fi

uv sync --quiet
rm -f "$URL_FILE"
.venv/bin/python -m studio --control-port "$CONTROL_PORT" --port "$STUDIO_PORT" "$@" &
STUDIO_PID=$!
trap 'kill $STUDIO_PID 2>/dev/null || true' EXIT INT TERM

# Tablet neu eingesteckt oder USB-Debugging neu freigegeben: Weiterleitung erneuern.
# Von hier gestartetes SolidCraft geschlossen: Studio beenden.
( while kill -0 $STUDIO_PID 2>/dev/null; do
    if tablet && ! "$ADB" reverse --list 2>/dev/null | grep -q "tcp:$STUDIO_PORT"; then
      "$ADB" reverse "tcp:$STUDIO_PORT" "tcp:$STUDIO_PORT" >/dev/null 2>&1 && say "Tablet wieder verbunden."
    fi
    if [ -n "$APP_PID" ] && ! kill -0 "$APP_PID" 2>/dev/null; then
      kill $STUDIO_PID 2>/dev/null
    fi
    sleep 3
  done ) &

for _ in $(seq 1 40); do [ -s "$URL_FILE" ] && break; sleep 0.25; done
open_on_tablet
wait $STUDIO_PID || true
say "Studio beendet."
