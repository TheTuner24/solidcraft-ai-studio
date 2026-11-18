# SolidCraft AI Studio

Mit Stift und Worten an einem echten, parametrischen CAD-Modell arbeiten. Der Benutzer zeichnet,
markiert und beschreibt auf dem Tablet (Galaxy Tab S8+ mit S Pen). Ein KI-Agent (Claude Code)
baut und ändert das Modell in der laufenden [SolidCraft](https://github.com/tangency-labs/solidcraft)-App
auf dem PC.

Das Studio ist eine eigenständige Erweiterung, kein Fork. Es spricht SolidCraft nur über dessen
offizielle Schnittstellen an: den Steuerkanal (`solidcraft --control PORT`) und den MCP-Server
(`solidcraft-cli mcp`). Updates von SolidCraft lassen sich deshalb ohne Merge übernehmen.

## Aufbau

```
Tablet (Firefox)                      PC
┌──────────────────────┐   WebSocket  ┌──────────────────────────────┐  Steuerkanal  ┌────────────┐
│ three.js-Ansicht     │◄────────────►│ Studio-Dienst (Python)       │◄────────────►│ SolidCraft │
│ Stift-Ebene, KI-Chat │   /model.glb │  · GLB-Export bei Änderung   │  127.0.0.1   │  (App)     │
└──────────────────────┘  adb reverse │  · Checkpoints, Speichern    │              └─────▲──────┘
                                      │  · Claude Code (headless) ───┼── MCP ─────────────┘
                                      └──────────────────────────────┘
```

- **Ansicht:** Nach jeder Änderung exportiert das Studio das Modell als GLB (`file.export`), das
  Tablet zeigt es mit three.js in SolidCraft-Weltkoordinaten (mm, Z oben). Die App am PC zeigt
  dasselbe Modell.
- **Stift:** Jeder Strich bekommt pro Punkt einen 3D-Anker. Das ist der Treffer am Modell mit
  Flächennormale, sonst die Bodenebene Z=0. Eingekreiste Bereiche werden zusätzlich innen abgetastet.
  Der Agent bekommt das Bild der Ansicht mit den Strichen, die 3D-Treffer und die Kamera im Format
  von SolidCraft (`ui.camera`). Er nutzt die Treffer als Picks für Kanten und Flächen.
- **Agent:** Ein langlebiger `claude -p`-Prozess (stream-json). Er hat keine eingebauten Werkzeuge,
  also keine Shell und keinen Dateizugriff, sondern nur den SolidCraft-MCP-Server. Dateipfade sind
  auf `~/CAD/ai-studio` begrenzt, Speichern, Öffnen und Export sind ihm gesperrt.
- **Sprache:** Das Mikrofon nimmt im Browser auf (MediaRecorder, Opus), der PC erkennt den Text lokal mit
  faster-whisper (`large-v3-turbo`, Deutsch, auf der GPU, etwa 0,3 s pro Satz). Es geht kein Audio ins Internet.
  Das Modell (~1,6 GB) wird beim ersten Start geladen und bleibt im Grafikspeicher (~1,5 GB).
  Abschalten mit `--no-speech`, anderes Modell mit `STUDIO_WHISPER_MODEL`.
- **Sicherheit:** Der Dienst lauscht nur auf `127.0.0.1` und prüft den Host-Header. Er braucht einen
  Zugangsschlüssel (`~/CAD/ai-studio/.cache/token`, löschen erzeugt einen neuen), der als Cookie gesetzt wird. Das Tablet kommt
  per `adb reverse` über USB. Ein API-Schlüssel liegt weder im Browser noch im Dienst: Claude Code
  nutzt die Anmeldung auf dem PC.
- **Nichts geht verloren:** Vor jeder KI-Runde setzt das Studio einen Checkpoint (`edit.checkpoint`).
  „KI-Runde“ nimmt eine ganze Runde zurück, Undo/Redo arbeiten schrittweise. Gespeichert wird nur
  in `~/CAD/ai-studio/`. Ein geöffnetes Original aus `~/CAD` wird als Kopie gespeichert, nie
  überschrieben. Jede Runde (Bild, Text, Striche, Kamera) wird in `<Projekt>.studio/` abgelegt.

## Starten

Voraussetzungen: SolidCraft ≥ 0.44 (`solidcraft`, `solidcraft-cli` im `PATH`), Claude Code (angemeldet),
`uv`, für das Tablet `adb` mit freigegebenem USB-Debugging und Firefox.

```bash
./start.sh
```

Oder über den Startmenü-Eintrag **SolidCraft AI Studio** (`~/.local/share/applications/solidcraft-ai-studio.desktop`,
ruft `start.sh` ohne Terminal auf: Meldungen als Benachrichtigung, Protokoll in `~/CAD/ai-studio/.cache/studio.log`).
Läuft das Studio schon, verbindet ein zweiter Aufruf nur das Tablet neu. Wurde SolidCraft vom Skript gestartet,
beendet sich das Studio mit SolidCraft.

Das Skript startet SolidCraft mit Steuerkanal (Port 7979), falls es noch nicht läuft. Es richtet die
USB-Weiterleitung ein, startet das Studio und öffnet die Oberfläche in Firefox auf dem Tablet. Den
Link mit Zugangsschlüssel gibt es auf der Konsole aus, er steht auch in
`~/CAD/ai-studio/.cache/studio-url.txt`. Am PC öffnet man denselben Link im Browser.

Optionen: `./start.sh --model sonnet` (anderes Modell), Umgebungsvariablen `CONTROL_PORT` und
`STUDIO_PORT`.

## Bedienung

| Eingabe | Wirkung |
|---|---|
| S Pen | zeichnen und markieren (Druckstärke = Strichbreite) |
| S-Pen-Taste gedrückt oder Werkzeug „Radierer“ | Striche wegradieren |
| ein Finger | Modell drehen |
| zwei Finger | zoomen und verschieben |
| Maus am PC | links zeichnen, rechts drehen, Mitte verschieben, Rad zoomen |
| 🎤 antippen, sprechen, nochmal antippen | gesprochener Text kommt ins Eingabefeld, prüfen, dann senden |
| Strg+Enter im Textfeld | senden |

Der Handballen wird ignoriert, solange der Stift aktiv ist. Mit „An PC“ übernimmt die SolidCraft-App
die Kamera des Tablets.

## Stand (Meilenstein 1, 18.11.2026)

Getestet mit SolidCraft 0.44.1 und Claude Code 2.1.326. Der Durchlauf lief automatisiert in Chrome
am PC (Maus statt Stift):

1. SolidCraft mit Steuerkanal starten, Studio-Oberfläche öffnen ✔
2. In der Draufsicht eine grobe Skizze zeichnen (Rechteck, zwei Kreise) ✔
3. Mit Text senden: „Grundplatte 60 × 40 × 5 mm, zwei Bohrungen Ø 5,5 mm, 36 mm Abstand“ ✔
4. Der Agent baut ein parametrisches Bauteil (Parameter `L`, `B`, `T`, `d_bohr`, `a_bohr`), misst nach
   und sagt, was er angenommen hat (durchgehende Bohrungen) ✔
5. Das Modell erscheint in der App am PC und auf der Oberfläche ✔
6. Eine senkrechte Kante einkreisen und „Rundung 8 mm“ sagen: Der Agent erkennt die Kante aus den
   3D-Treffern und rundet genau diese, als neues Feature mit Parameter `r_ecke` ✔
7. Speichern nach `~/CAD/ai-studio/Halterung.sc`, Runden in `Halterung.studio/` ✔

Eine KI-Runde dauerte im Test 10–20 Sekunden.

### Einschränkungen

- Mit echtem S Pen auf dem Tablet ist noch nicht getestet. Das Zeichnen läuft über Pointer Events
  mit `pointerType === 'pen'`. Die Erkennung der S-Pen-Taste als Radierer ist noch nicht geprüft.
- Die Spracheingabe ist mit Aufnahmen getestet, aber noch nicht mit dem Mikrofon des Tablets. Firefox fragt
  beim ersten Mal nach der Mikrofon-Erlaubnis.
- Die Ansicht auf dem Tablet ist ein Netz-Export: Sie zeigt Flächen und Kanten, aber keine
  Skizzen, Achsen oder Bemaßungen aus SolidCraft.
- Der Agent bekommt Freihandskizzen als Bild. Formen erkennt er gut, Maße müssen aus dem Text kommen.
- Nur ein Tablet zur Zeit sinnvoll: Alle verbundenen Oberflächen teilen sich denselben Agenten.
- „Öffnen“ zeigt nur `.sc`-Dateien direkt in `~/CAD` und `~/CAD/ai-studio`.

## Nächste Schritte

1. Test auf dem Galaxy Tab mit S Pen: Handballen, Druck, S-Pen-Taste, Zwei-Finger-Gesten.
2. Sprache weiter: optional sofort senden, Antworten mit Piper vorlesen.
3. Fotos von Papierskizzen importieren (Kamera oder Datei im Browser, als Bild an den Agenten).
4. Rückfragen des Agenten mit Antwort-Knöpfen. Bevor der Agent ändert, zeigt das Tablet Kanten und
   Flächen hervorgehoben (über `select.set`), der Benutzer bestätigt.
5. HTTPS mit eigener CA für den Betrieb im WLAN ohne USB.
