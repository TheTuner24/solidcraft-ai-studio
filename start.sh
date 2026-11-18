#!/usr/bin/env bash
# Startet SolidCraft (falls nötig), die USB-Weiterleitung zum Tablet und das Studio.
set -euo pipefail
cd "$(dirname "$0")"

CONTROL_PORT="${CONTROL_PORT:-7979}"
STUDIO_PORT="${STUDIO_PORT:-8765}"
CONTROL_DIR="$HOME/.local/share/solidcraft/control"

if ! (exec 3<>/dev/tcp/127.0.0.1/"$CONTROL_PORT") 2>/dev/null; then
  echo "Starte SolidCraft mit Steuerkanal auf Port $CONTROL_PORT …"
  nohup solidcraft --control "$CONTROL_PORT" >"${XDG_RUNTIME_DIR:-/tmp}/solidcraft-studio-app.log" 2>&1 &
  for _ in $(seq 1 60); do
    [ -s "$CONTROL_DIR/$CONTROL_PORT.token" ] && (exec 3<>/dev/tcp/127.0.0.1/"$CONTROL_PORT") 2>/dev/null && break
    sleep 0.5
  done
fi

ADB="$(command -v adb || echo "$HOME/Android/Sdk/platform-tools/adb")"
if [ -x "$ADB" ] && "$ADB" get-state >/dev/null 2>&1; then
  "$ADB" reverse "tcp:$STUDIO_PORT" "tcp:$STUDIO_PORT" >/dev/null
  echo "Tablet per USB verbunden: localhost:$STUDIO_PORT wird weitergeleitet."
  TABLET=1
else
  echo "Kein Tablet per USB gefunden (adb). Das Studio läuft trotzdem am PC."
  TABLET=0
fi

URL_FILE="$HOME/CAD/ai-studio/.cache/studio-url.txt"
rm -f "$URL_FILE"
uv run --quiet python -m studio --control-port "$CONTROL_PORT" --port "$STUDIO_PORT" "$@" &
STUDIO_PID=$!
# Tablet neu eingesteckt oder USB-Debugging neu freigegeben: Weiterleitung von selbst erneuern.
if [ -x "$ADB" ]; then
  ( while kill -0 $STUDIO_PID 2>/dev/null; do
      if "$ADB" get-state >/dev/null 2>&1 && ! "$ADB" reverse --list 2>/dev/null | grep -q "tcp:$STUDIO_PORT"; then
        "$ADB" reverse "tcp:$STUDIO_PORT" "tcp:$STUDIO_PORT" >/dev/null 2>&1 && echo "Tablet wieder verbunden."
      fi
      sleep 3
    done ) &
fi
trap 'kill $STUDIO_PID 2>/dev/null' EXIT INT TERM
for _ in $(seq 1 40); do [ -s "$URL_FILE" ] && break; sleep 0.25; done

if [ "$TABLET" = 1 ] && [ -s "$URL_FILE" ]; then
  "$ADB" shell am start -a android.intent.action.VIEW -d "$(cat "$URL_FILE")" org.mozilla.firefox >/dev/null 2>&1 \
    && echo "Firefox auf dem Tablet geöffnet." \
    || echo "Firefox auf dem Tablet nicht gefunden: Link oben von Hand öffnen."
fi
wait $STUDIO_PID
