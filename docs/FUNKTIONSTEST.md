# Funktionstest / Functional test

*English summary below.*

Ein reproduzierbarer Test für alle, die SolidCraft AI Studio selbst aufsetzen. Teil A läuft
automatisch im Browser am PC. Teil B ist eine Prüfliste für das echte Tablet mit Stift.

## Voraussetzungen

- Linux-PC mit SolidCraft ≥ 0.44 (`solidcraft` und `solidcraft-cli` im `PATH`)
- [uv](https://docs.astral.sh/uv/) und Python ≥ 3.11
- [Claude Code](https://claude.com/claude-code), angemeldet (`claude` im `PATH`). Nur für den Volltest
  und die KI-Funktionen.
- Node.js ≥ 18 und Chrome oder Chromium für die Testautomatik
- Optional: NVIDIA-GPU für die Spracherkennung (ohne GPU läuft Whisper langsamer auf der CPU)
- Für Teil B: Android-Tablet mit Stift, Firefox, USB-Debugging aktiv, `adb` am PC

## Teil A – automatischer Test

### A1. Studio starten

```bash
git clone https://github.com/TheTuner24/solidcraft-ai-studio.git
cd solidcraft-ai-studio
./start.sh
```

Erwartet: SolidCraft öffnet sich (Steuerkanal auf Port 7979). Auf der Konsole steht
`SolidCraft AI Studio läuft.` mit einem Link `http://localhost:8765/?t=…`.

### A2. Smoke-Test (ohne KI, ändert nichts am Design)

```bash
cd tests/funktionstest
npm install
npm run smoke          # oder: CHROME=/pfad/zu/chrome node funktionstest.mjs --smoke
```

Erwartet:

```
OK   WebSocket-Verbindung zum Studio steht
OK   Oberfläche geladen (three.js, Testschnittstelle)
OK   Strich wird als ein abgeschlossener Strich erkannt
OK   Anzeige der Markierung: "1 Strich, …"
OK   Farbwahl: Blau ist aktiv
OK   Jeder Strich behält seine Farbe: ["rot","blau"]
OK   Strichdaten für die KI enthalten die Farbe je Strich
OK   Übertragenes Bild enthält den blauen Strich
OK   Anzeige zählt Striche je Farbe
OK   Palette mit 6 Farben
OK   Stift zeichnet mit Druck (0.10…1.00)
OK   Zweiter Stiftstrich
OK   „↩ Strich“ entfernt nur den letzten Strich
OK   Stifttaste gedrückt: Stift radiert
OK   Werkzeug „Radierer“: Stift radiert beim Darüberziehen
OK   Berührung direkt nach dem Stift wird ignoriert (Handballen)
OK   Große Kontaktfläche wird ignoriert (Handballen)
OK   Finger dreht das Modell und zeichnet nicht
OK   Handballen zuerst, dann Stift: Strich entsteht, Modell bewegt sich nicht
OK   Navigation nach den Tests wieder frei
OK   Nach dem Senden ist die Zeichenebene leer
OK   „⤺ Skizze“ holt die gesendete Skizze mit Farben zurück
OK   Blickwinkel der Skizze wird wiederhergestellt
OK   Zurückgeholte Striche sind sichtbar
OK   Spracheingabe und -ausgabe verfügbar (stt true, tts true)
OK   Sprachausgabe liefert WAV (… Byte)
OK   Vorgelesener Satz im Mikrofon wird als Echo erkannt und verworfen
OK   🔊 schaltet das Vorlesen aus
OK   Ausgeschaltet: nichts wird vorgelesen
OK   Während des Vorlesens ist das Mikrofon aus (kein Echo)
OK   Nach der Rückfrage hört das Mikrofon automatisch zu
OK   Gesprochene Antwort steht im Eingabefeld: "Durchmesser 5 mm"
OK   Rückfrage wurde vorgelesen
OK   🎤 während des Vorlesens: Ausgabe stoppt, Aufnahme startet
OK   Aufnahme nach dem Unterbrechen wird erkannt
OK   „Striche löschen“ entfernt alle Striche
Alle Prüfungen bestanden.
```

Stift und Finger werden dabei als **echte Eingabeereignisse** über das Chrome-DevTools-Protokoll
erzeugt: Stift mit `pointerType: "pen"` und Druck, Finger als Touch mit Kontaktradius. Das
Radiererende des Stifts (`buttons 32`) lässt sich so nicht erzeugen. Es steht deshalb nur in der
Tablet-Prüfliste.

Für die Sprachprüfungen startet Chrome mit einer **Mikrofon-Attrappe**, die
`tests/funktionstest/testdaten/durchmesser.wav` in Schleife abspielt („Durchmesser fünf Millimeter.“,
mit Piper erzeugt). Spracheingabe und -ausgabe müssen im Studio aktiv sein, also nicht `--no-speech`
oder `--no-voice`.

### A3. Volltest mit KI (verbraucht Claude-Kontingent, etwa 1 Minute)

Der Volltest legt mit „Neu“ ein neues Bauteil an. Er soll deshalb gegen eine **eigene Test-Instanz**
laufen, nicht gegen die Arbeitssitzung:

```bash
mkdir -p /tmp/studio-test
solidcraft --control 7980 &
uv run python -m studio --control-port 7980 --port 8766 --projects /tmp/studio-test &
cd tests/funktionstest
STUDIO_URL="$(cat /tmp/studio-test/.cache/studio-url.txt)" CONTROL_PORT=7980 npm run full
```

Ablauf:
1. Neues Bauteil „Funktionstest“
2. Draufsicht, grob ein Rechteck und zwei Kreise zeichnen
3. Text senden: Platte 60 × 40 × 5 mm, zwei Bohrungen Ø 5,5 mm, 36 mm Abstand
4. **Prüfung über den Steuerkanal:** Volumen ≈ 11 762 mm³ (Toleranz ±1 %)
5. Iso-Ansicht, die senkrechte Kante bei (+30, +20) einkreisen, „Rundung mit acht Millimetern Radius“
6. **Prüfung:** Volumen ≈ 11 694 mm³ (genau diese eine Kante gerundet, ±5 mm³)
7. Draufsicht: **grün** eine Stelle einkreisen, **violett** die Ecke (−30, −20) einkreisen. Text:
   „Grün ist eine neue durchgehende Bohrung mit 4 mm Durchmesser … Violett … Fase von 2 mm“
8. **Prüfung:** Volumen ≈ 11 621 mm³ (Bohrung und Fase in einer Runde). Die Legende enthält grün und
   violett, die Steuerzeile ist im Dialog ausgeblendet, die Palette zeigt die Bedeutung.
9. Nach jeder Runde: Die Zeichenebene ist leer.
10. Speichern: `Funktionstest.sc` im Projektordner

Die Prüfung misst das Volumen der echten Geometrie in SolidCraft, sie verlässt sich nicht auf die
Antwort der KI. Bilder der Ansicht landen in `tests/funktionstest/ergebnis/`. `SICHTBAR=1` zeigt
den Browser.

### A4. Skizze über Neustarts (ohne KI, nur Test-Instanz)

Prüft, dass ein geöffnetes Projekt seine letzte Skizze zurückbringt. Der Test legt in der Test-Instanz
das Bauteil `SkizzeLaden.sc` an und öffnet es mehrmals, deshalb nie gegen die Arbeitssitzung:

```bash
cd tests/funktionstest
PROJEKTE=/tmp/studio-test STUDIO_URL="$(cat /tmp/studio-test/.cache/studio-url.txt)" CONTROL_PORT=7980 node skizze_laden.mjs
```

Erwartung: Eine Runde nach dem letzten Speichern kommt mit Strichen, Farben, Druck, Blickwinkel
(Abweichung < 2 px) und Text sofort zurück. Eine ältere Runde liegt nur unter „⤺ Skizze“ bereit.
Runden im alten Format (nur 3D-Punkte) werden aus den Punkten nachgebildet.

## Teil B – Prüfliste auf dem Tablet

Mit `./start.sh` bei angeschlossenem Tablet (USB-Debugging an) öffnet sich die Oberfläche in Firefox.
Beim ersten Mal den Link mit `?t=…` öffnen, danach merkt sich Firefox den Zugang.

| # | Aktion | Erwartet | Stand |
|---|---|---|---|
| B1 | Mit dem Stift leicht und dann fest zeichnen | Strich wird mit dem Druck sichtbar breiter | ✅ Tablet (20.11.) |
| B2 | Beim Zeichnen den Handballen auflegen und bewegen, auch vor dem Aufsetzen des Stifts | Modell dreht sich nicht, kein Fingerstrich | ✅ Tablet (20.11.) |
| B3 | Ein Finger ziehen / zwei Finger spreizen | Modell dreht / zoomt und verschiebt | ✅ Tablet (20.11.) |
| B4 | S-Pen-Taste gedrückt halten und über einen Strich fahren | Strich wird radiert. Hängt davon ab, ob Firefox die Taste meldet. | ❌ Tablet (20.11.): radiert nicht, ✅ automatisch |
| B5 | Werkzeug „Radierer“, über einen Strich fahren | Strich wird radiert | 🟡 (Tablet), ✅ automatisch |
| B5a | „↩ Strich“ | nur der letzte Strich verschwindet | ✅ automatisch |
| B6 | Eine Kante einkreisen, „Rundung 3 mm“ eingeben, Senden | KI rundet genau diese Kante, Ansicht aktualisiert sich | ✅ |
| B7 | 🎤 antippen, Satz sprechen, 🎤 antippen | Satz steht im Eingabefeld (beim ersten Mal Mikrofon erlauben) | ✅ |
| B8 | „KI-Runde“ antippen, bestätigen | letzte KI-Änderung ist komplett zurückgenommen | 🟡 |
| B9 | Undo / Redo | einzelne CAD-Schritte zurück/vor | 🟡 |
| B10 | „An PC“ | SolidCraft am PC zeigt dieselbe Ansicht | 🟡 |
| B11 | Speichern | Meldung „Gespeichert: …/Name.sc“, Punkt • neben dem Namen verschwindet | ✅ (automatisch) |
| B12 | Kabel ziehen, wieder einstecken | nach wenigen Sekunden wieder verbunden (Seite neu laden) | 🟡 |
| B14 | Eine Frage stellen, auf die die KI zurückfragt (z. B. „Mach eine Bohrung“ ohne Maß) | Rückfrage wird vorgelesen, danach geht 🎤 von selbst an. Antwort sprechen, sie steht im Feld. | 🟡 (Tablet), ✅ automatisch |
| B15 | Während des Vorlesens 🎤 antippen | Vorlesen stoppt sofort, Aufnahme läuft | 🟡 (Tablet), ✅ automatisch |
| B16 | Lautsprecher laut, Vorlesen läuft, nicht sprechen | Vorgelesenes landet **nicht** im Eingabefeld (sonst Meldung „Eigene Sprachausgabe … verworfen“) | 🟡 nur Tablet |
| B17 | 🔊 ausschalten, Seite neu laden | Vorlesen bleibt aus | 🟡 |
| B18 | Skizze senden, KI versteht falsch → „KI-Runde“ | Änderung ist zurückgenommen, Skizze ist wieder da (gleicher Blickwinkel), korrigieren, neu senden | 🟡 (Tablet), ✅ automatisch (ohne KI) |
| B13 | Farbpunkt mit dem Stift antippen, Strich zeichnen | Strich in der gewählten Farbe; Bedeutung erscheint nach der KI-Antwort unter dem Farbpunkt | ✅ Tablet (20.11.) |

Legende: ✅ geprüft · ❌ Fehler · 🟡 noch zu prüfen. Ergebnisse gehören in [STAND.md](../STAND.md).

---

## English summary

A reproducible test for anyone setting up SolidCraft AI Studio.

- **Part A (automated):**
  1. Start the studio with `./start.sh`.
  2. In `tests/funktionstest`, run `npm install`, then `npm run smoke`. This needs no AI and does
     not change the design.
  3. For the full test, run `npm run full` against a **separate test instance** (commands in A3).
     It builds a 60 × 40 × 5 mm plate with two Ø 5.5 mm holes from a sketch and a text prompt,
     then fillets one circled edge with R 8. In a third turn two colours carry two different tasks
     (green = new hole, violet = chamfer, meaning given only in the text), then the part is saved.
  4. Results are verified by **measuring the real geometry** through SolidCraft's control channel:
     volumes of 11 762 mm³ and 11 694 mm³.
- **Part B (manual, tablet with pen):** the checklist above covers pen drawing, palm rejection,
  pen button and eraser, finger gestures, edge marking, voice input, undo and save.
