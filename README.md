# SolidCraft AI Studio

*[English version](README.en.md)*

Mit Stift, Sprache und Text an einem **echten, parametrischen CAD-Modell** arbeiten. Der Benutzer
zeichnet, markiert und beschreibt auf dem Tablet (entwickelt für Galaxy Tab S8+ mit S Pen). Ein
KI-Agent baut und ändert das Modell in der laufenden [SolidCraft](https://github.com/tangency-labs/solidcraft)-App
auf dem PC, Schritt für Schritt, prüft seine Arbeit und fragt nach, wenn etwas unklar ist.

Das Studio ist eine eigenständige Erweiterung, kein Fork. Es nutzt nur die offiziellen
Schnittstellen von SolidCraft: den Steuerkanal (`solidcraft --control PORT`) und den MCP-Server
(`solidcraft-cli mcp`). SolidCraft-Updates lassen sich ohne Merge übernehmen.

> **Stand:** Prototyp (Meilenstein 1 erreicht). Was genau funktioniert, was getestet ist und was
> fehlt, steht in **[STAND.md](STAND.md)**. Die Anforderungen stehen in [docs/AUFTRAG.md](docs/AUFTRAG.md).

## Was es kann

| Funktion | Stand |
|---|---|
| Freihand skizzieren und auf dem 3D-Modell markieren (Stift oder Maus) | ✅ getestet |
| Skizze + Text → parametrisches Bauteil in SolidCraft | ✅ getestet |
| Kante einkreisen + Änderung beschreiben → genau diese Kante wird geändert | ✅ getestet |
| Modell auf dem Tablet drehen/zoomen, Ansicht aktualisiert sich nach jeder Änderung | ✅ getestet |
| Spracheingabe (lokal mit Whisper, Text landet im Eingabefeld) | ✅ getestet (auch auf dem Tablet) |
| Sprachausgabe: Antworten vorlesen (lokal mit Piper), abschaltbar, Rückfragen per Sprache beantworten, Echo-Schutz | ✅ automatisch getestet (Tablet-Prüfung 🟡) |
| Undo/Redo, „KI-Runde zurück“ | ✅ / 🟡 teilweise getestet |
| Öffnen und Speichern am PC in SolidCraft, das Tablet folgt der offenen Datei (auch auf dem NAS) | ✅ getestet |
| SolidCraft-Skizzen auf dem Tablet sichtbar (gelb, Hilfslinien gestrichelt). Stiftstriche haften an Skizzenlinien und -ebenen, auch ohne Körper, und bleiben beim Drehen an ihrem Platz. | ✅ getestet |
| S Pen: Druck → Strichbreite, Handballen-Erkennung, Stifttaste radiert, Stift zeichnet / Finger navigiert | ✅ automatisch getestet (Tablet-Prüfung 🟡) |
| KI lokal über Ollama (Umschalter) | ⛔ experimentell, mit 8 GB Grafikspeicher nicht brauchbar |
| Linienfarben: Farbe je Strich, Bedeutung legst du per Sprache/Text fest („grün ist eine Bohrung Ø 4“) | ✅ getestet (Tablet-Bedienung 🟡) |
| Vektorisierung der Striche, native bemaßte SolidCraft-Skizzen | 📋 geplant |
| Drahtlos über WLAN (ohne USB) | 📋 geplant |

✅ getestet · 🟡 implementiert, nicht vollständig getestet · 📋 geplant · ⛔ zurückgestellt

## Aufbau

```
Tablet (Firefox)                      PC
┌──────────────────────┐   WebSocket  ┌──────────────────────────────┐  Steuerkanal  ┌────────────┐
│ three.js-Ansicht     │◄────────────►│ Studio-Dienst (Python)       │◄────────────►│ SolidCraft │
│ Stift-Ebene, KI-Chat │   /model.glb │  · GLB-Export bei Änderung   │  127.0.0.1   │  (App)     │
│ Mikrofon             │   /stt       │  · Checkpoints, Speichern    │              └─────▲──────┘
└──────────────────────┘  adb reverse │  · Whisper (Sprache → Text)  │                    │
                                      │  · Agent: Claude Code ───────┼── MCP ─────────────┘
                                      └──────────────────────────────┘
```

- **Ansicht:** Nach jeder Änderung exportiert das Studio das Modell als GLB (`file.export`). Das Tablet
  zeigt es mit three.js in SolidCraft-Weltkoordinaten (mm, Z oben). Die App am PC zeigt dasselbe Modell.
- **Stift:** Jeder Strichpunkt bekommt einen 3D-Anker: eine SolidCraft-Skizzenlinie in Stiftnähe
  (≈ 10 px), sonst der Treffer am Modell mit Flächennormale oder an einer Skizzenebene, sonst die
  Bodenebene Z = 0. Ein Strich bleibt bei der Skizze, auf der er überwiegend liegt. Eingekreiste Bereiche werden innen abgetastet. Der Agent
  bekommt das Bild der Ansicht mit den Strichen, die 3D-Punkte und die Kamera (`ui.camera`-Format).
  Er nutzt die Punkte als Picks für Kanten und Flächen.
- **Agent:** Ein langlebiger `claude -p`-Prozess (stream-json). Er hat **keine** Shell und keinen
  Dateizugriff, nur den SolidCraft-MCP-Server. Speichern, Öffnen und Export sind ihm gesperrt,
  Dateipfade auf den Studio-Ordner begrenzt. Die Systemanweisung steht in `studio/agent.py`.
- **Sprache:** Alles läuft lokal auf dem PC, es geht kein Audio ins Internet.
  - Eingabe: Das Browser-Mikrofon nimmt auf (MediaRecorder, Opus), der PC erkennt den Text mit
    faster-whisper (`large-v3-turbo`, Deutsch).
  - Ausgabe: Der PC liest die Antworten mit [Piper](https://github.com/OHF-Voice/piper1-gpl) vor (Stimme
    `de_DE-thorsten-medium`, wird beim ersten Start nach `~/.local/share/solidcraft-ai-studio/voices` geladen).
  - Rückfragen: Nach einer Rückfrage hört das Mikrofon automatisch zu (👂) und stoppt bei einer Sprechpause.
  - Echo-Schutz: Vorlesen und Aufnahme laufen nie gleichzeitig. Aufnahmen, die dem gerade Vorgelesenen
    gleichen, verwirft der PC.
- **Stift und Finger:**
  - Nur der Stift (und die linke Maustaste) zeichnet. Finger drehen, zoomen und verschieben.
  - Ein Handballen wird ignoriert: während der Stift schreibt oder schwebt, bis 600 ms danach und bei
    großer Kontaktfläche (≥ 40 px).
  - Setzt der Stift auf, während ein Finger liegt, ist die Navigation bis zum Strichende gesperrt.
  - Schwellen: `PALM_MS` und `PALM_SIZE` in `web/app.js`.
- **Farben:** Jeder Strich trägt seine Farbe. Sie ist im Bild sichtbar und steht in den Strichdaten.
  Was eine Farbe bedeutet, sagst du der KI in Worten, fest eingebaute Farbfunktionen gibt es nicht. Die
  KI meldet die Legende zurück, das Studio zeigt sie an der Palette, speichert sie beim Projekt und gibt
  sie jeder Runde mit. Mehrere Farben mit verschiedenen Aufgaben in einer Runde sind möglich.
- **Sicherheit:**
  - Der Dienst lauscht nur auf `127.0.0.1` und prüft den Host-Header.
  - Er braucht einen Zugangsschlüssel als Cookie.
  - Das Tablet verbindet sich per `adb reverse` über USB.
  - API-Schlüssel gibt es weder im Browser noch im Dienst: Claude Code nutzt die eigene Anmeldung am PC.
- **Nichts geht verloren:**
  - Vor jeder KI-Runde setzt das Studio einen Checkpoint (`edit.checkpoint`).
  - Öffnen, Neu und Speichern machst du **am PC in SolidCraft**, auch direkt auf dem NAS. Das Tablet
    folgt der dort offenen Datei, es öffnet und speichert selbst nichts.
  - Jede Runde (Bild, Text, Striche, 3D-Punkte, Kamera) wird neben der Datei in `<Datei>.studio/`
    abgelegt, vor dem ersten Speichern in `~/CAD/ai-studio/sitzungen/`. Beim Speichern am PC wandern
    die Runden mit.

## Installation und Start

Voraussetzungen:
- Linux, SolidCraft ≥ 0.44 (`solidcraft`, `solidcraft-cli` im `PATH`)
- [uv](https://docs.astral.sh/uv/), [Claude Code](https://claude.com/claude-code) (angemeldet)
- Für das Tablet: `adb`, USB-Debugging, Firefox
- Für Sprache: am besten eine NVIDIA-GPU. Das Whisper-Modell (~1,6 GB) und die Piper-Stimme (~63 MB)
  werden beim ersten Start geladen.

```bash
git clone https://github.com/TheTuner24/solidcraft-ai-studio.git
cd solidcraft-ai-studio
./start.sh
```

`start.sh` erledigt alles in einem Schritt:
- startet SolidCraft mit Steuerkanal (Port 7979), falls es nicht läuft,
- richtet die USB-Weiterleitung ein und hält sie aktuell, auch nach Neueinstecken,
- startet das Studio,
- öffnet die Oberfläche in Firefox auf dem Tablet.

Den Link mit Zugangsschlüssel zeigt es auf der Konsole, er steht auch in
`~/CAD/ai-studio/.cache/studio-url.txt`. Am PC öffnet man denselben Link im Browser.

Optionen:

| Aufruf | Wirkung |
|---|---|
| `./start.sh --model sonnet` | anderes Claude-Modell |
| `./start.sh --no-speech` | ohne Spracherkennung |
| `./start.sh --no-voice` | ohne Sprachausgabe |
| `./start.sh --local-model NAME` | Ollama-Modell für „Lokal“ |
| `CONTROL_PORT`, `STUDIO_PORT`, `STUDIO_WHISPER_MODEL`, `STUDIO_PIPER_VOICE` | Ports, Whisper-Modell, Piper-Stimme |

**Startmenü-Eintrag** (optional):

```bash
sed "s#@DIR@#$PWD#" packaging/solidcraft-ai-studio.desktop.in > ~/.local/share/applications/solidcraft-ai-studio.desktop
```

Das Studio hat ein eigenes Icon (Tablet mit Stift und „AI“-Plakette). So ist es im Startmenü und in
den Favoriten nicht mit dem normalen SolidCraft zu verwechseln. Wer SolidCraft dort schon als Favorit
hat, ersetzt ihn durch das Studio: Nur so startet SolidCraft mit Steuerkanal und Tablet-Oberfläche.

Aus dem Startmenü gestartet, meldet sich das Studio per Benachrichtigung und schreibt nach
`~/CAD/ai-studio/.cache/studio.log`. Ein zweiter Aufruf verbindet nur das Tablet neu. Wurde
SolidCraft vom Skript gestartet, endet das Studio mit SolidCraft.

## Bedienung

| Eingabe | Wirkung |
|---|---|
| Stift | zeichnen und markieren (Druck = Strichbreite) |
| Farbpunkt in der Leiste | Strichfarbe wählen. Unter dem Punkt steht die Bedeutung, die du der KI genannt hast. |
| Stifttaste gedrückt, Radiererende oder Werkzeug „Radierer“ | Striche radieren |
| ↩ Strich / ✕ Alle | letzten Strich bzw. alle Striche entfernen |
| ⤺ Skizze | zuletzt gesendete Skizze samt Blickwinkel zurückholen, korrigieren und neu senden. „KI-Runde“ holt sie automatisch zurück. Auch nach einem Neustart: Öffnest du am PC eine Datei, liegt ihre letzte Skizze hier bereit. War die letzte Runde noch nicht gespeichert, kommen Skizze und Text sofort zurück. |
| ein Finger | Modell drehen |
| zwei Finger | zoomen und verschieben |
| Maus am PC | links zeichnen, rechts drehen, Mitte verschieben, Rad zoomen |
| 🎤 antippen – sprechen – antippen | erkannter Text kommt ins Eingabefeld, prüfen, dann senden. Während des Vorlesens: Vorlesen stoppt, Aufnahme beginnt. |
| 🔊 / 🔇 | Vorlesen an/aus |
| 👂 | nach einer Rückfrage automatisch zuhören an/aus |
| Strg+Enter | senden |
| KI-Runde | letzte KI-Änderung komplett zurücknehmen |
| An PC | SolidCraft übernimmt die Kamera des Tablets |
| Online / Lokal | KI über Claude oder über ein lokales Ollama-Modell |
| Dateiname oben rechts | die am PC offene Datei, • = ungespeicherte Änderungen (am PC speichern) |

## Funktionstest

Ein reproduzierbarer Test (automatisch im Browser, dazu eine Prüfliste für das Tablet) steht in
**[docs/FUNKTIONSTEST.md](docs/FUNKTIONSTEST.md)**. Kurzform:

```bash
cd tests/funktionstest && npm install && npm run smoke
```

## Mitarbeit und Projektregeln

Regeln für Weiterentwicklung und Dokumentation, auch für KI-Assistenten: [CLAUDE.md](CLAUDE.md).
Den aktuellen Stand und die nächsten Schritte beschreibt [STAND.md](STAND.md).

## Lizenz

MIT, siehe [LICENSE](LICENSE). Mitgeliefert ist [three.js](https://threejs.org) 0.170.0 in
`web/vendor/` (MIT, siehe `web/vendor/THREE-LICENSE`). SolidCraft ist nicht enthalten und wird
separat installiert.

Abhängigkeiten werden bei der Installation geladen, nicht mitgeliefert. Darunter sind
faster-whisper (MIT) und für die Sprachausgabe [piper-tts](https://github.com/OHF-Voice/piper1-gpl)
(**GPL-3.0**) mit der Stimme `de_DE-thorsten-medium` (Thorsten-Datensatz, CC0). Wer das Studio ohne
GPL-Komponente nutzen will, startet mit `--no-voice` und entfernt `piper-tts` aus `pyproject.toml`.
