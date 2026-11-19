# Entwicklungsstand

> Diese Datei ist die Übergabe zwischen Entwicklungssitzungen, ob von Menschen oder KI. Sie wird nach
> jedem abgeschlossenen Entwicklungsabschnitt aktualisiert (siehe [CLAUDE.md](CLAUDE.md)).
> Die Anforderungen stehen in [docs/AUFTRAG.md](docs/AUFTRAG.md), der Funktionstest in
> [docs/FUNKTIONSTEST.md](docs/FUNKTIONSTEST.md).

**Letzte Aktualisierung:** 19.11.2026 · **Version:** 0.1.0 · **Getestet mit:** SolidCraft 0.44.1,
Claude Code 2.1.x, Firefox für Android, Chrome (Testautomatik), Linux (CachyOS), RTX 4060 8 GB,
Galaxy Tab S8+

## Statuslegende

| Zeichen | Bedeutung |
|---|---|
| ✅ | implementiert **und getestet**: automatischer Test oder geprüfte Bedienung auf dem Tablet |
| 🟡 | implementiert, aber **nicht oder nur teilweise getestet** |
| 📋 | **geplant**, noch nicht implementiert |
| ⛔ | bewusst zurückgestellt |

## Kurzfassung

- **Meilenstein 1 ist erreicht.** Skizze und Text auf dem Tablet ergeben ein parametrisches Bauteil
  in SolidCraft. Danach kommen Kante einkreisen, Änderung beschreiben, das bestehende Modell ändern
  und speichern. Der Ablauf ist automatisch getestet und auf dem Tablet benutzt.
- **Spracheingabe** (Sprache → Text) läuft lokal mit Whisper. **Sprachausgabe** fehlt.
- **Der Benutzer hat die Schwerpunkte erweitert:** Linienfarben mit Bedeutung, Vektor- statt
  Bildskizzen, native bemaßte Skizzen, drahtloser Betrieb. Diese sind überwiegend noch offen (siehe unten).

## Abgleich mit den Schwerpunkten (19.11.2026)

| # | Schwerpunkt | Stand | Was es gibt | Was fehlt |
|---|---|---|---|---|
| 1 | Linienfarben, Bedeutung per Sprache festlegen | 📋 | Alle Striche sind rot, eine Bedeutung gibt es nicht. | Farbwahl im Werkzeug, Farbe je Strich an den Agenten, „Rot heißt Bohrung“ per Sprache als Legende speichern und anwenden |
| 2 | Bild- und vektorbasierte Skizzenverarbeitung | 🟡 teilweise ✅ | Der Agent bekommt **beides**: das Bild der Ansicht mit den Strichen und je Strich Punkte mit 3D-Ankern (Modelltreffer mit Normale, sonst Boden Z=0), geschlossen/offen und Innenabtastung. Die Kantenerkennung über die Punkte ist getestet (Runde 2). | Echte Vektorisierung: Strich in Linien, Bögen und Kreise zerlegen (Fitting), Ecken, Parallelität und Tangenten erkennen. Die 2D-Polylinien werden heute nur gekürzt übertragen. |
| 3 | Handzeichnung → native, bemaßte CAD-Skizze | 📋 | Der Agent baut aus der Beschreibung parametrische Features (Parameter für Hauptmaße). Er erzeugt dabei nicht zwingend eine SolidCraft-Skizze aus den Strichen. | Erkannte Geometrie als `sketch.*`-Elemente mit Bedingungen und Bemaßungen (`sketch.dimension`, dof 0) anlegen. Maße aus Sprache oder Text zuordnen, handgeschriebene Maße erkennen. |
| 4 | Zuverlässige S-Pen-Bedienung | 🟡 | Stift zeichnet (Pointer Events `pen`), Druck steuert die Strichbreite. Finger dreht, zwei Finger zoomen und verschieben. Berührungen bis 600 ms nach Stiftkontakt werden ignoriert (Handballen). S-Pen-Taste und Radiererende radieren. Grundbedienung (zeichnen, einkreisen, drehen) hat der Benutzer auf dem Tablet verwendet. | Systematischer Test: Druck, Handballen beim Schreiben, S-Pen-Taste, Hover, schnelle Striche, Zwei-Finger-Geste während Stiftkontakt. Undo für einzelne Striche fehlt. |
| 5 | Bidirektionale Sprachkommunikation | 🟡 Eingabe ✅, Ausgabe 📋 | Mikrofon-Knopf → Whisper `large-v3-turbo` lokal auf der GPU → Text ins Eingabefeld → selbst senden. Getestet mit Aufnahmen (4/4 Wörter, ~0,3 s), im Testbrowser mit Mikrofon-Attrappe, vom Benutzer auf dem Tablet. | Antworten vorlesen (lokal, z. B. Piper), Wechselgespräch (Rückfrage → Antwort per Sprache), optional automatisch senden |
| 6 | Drahtlose Tablet-Anbindung | 📋 | Nur USB (`adb reverse`), der Dienst lauscht auf 127.0.0.1. | HTTPS mit eigener Zertifizierungsstelle (Mikrofon braucht einen sicheren Kontext), Lauschen im LAN, Kopplung per Zugangsschlüssel/QR-Code, Schutz gegen Zugriff von außen |
| 7 | Vollständige Dokumentation auf GitHub | ✅ (dieser Stand) | README (DE und EN), STAND.md, Auftrag, reproduzierbarer Funktionstest, Projektregeln (CLAUDE.md/AGENTS.md) | wird mit jedem Abschnitt fortgeschrieben |

## Abgleich mit dem ursprünglichen Auftrag

| Anforderung | Stand | Anmerkung |
|---|---|---|
| **Meilenstein 1, Schritte 1–9** | ✅ | automatischer Test `--full`, siehe Testprotokoll |
| A: Freihand zeichnen | ✅ | |
| A: Maße und Beschriftungen ergänzen | 🟡 | nur als Bild (handschriftlich) bzw. per Text/Sprache. Keine Handschrifterkennung, keine Bemaßungsobjekte |
| A: Vorhandene Zeichnungen öffnen | 🟡 | `.sc` aus dem Studio-Ordner und dessen Elternordner. Originale werden als Kopie gespeichert. Nicht automatisch getestet. |
| A: Fotos von Papierskizzen importieren | 📋 | |
| A: Korrigieren und löschen | ✅ | Radierer, „Striche löschen“ (Smoke-Test) |
| B: Skizze und Sprache gemeinsam interpretieren | ✅ | Bild, Striche und Text in einer Runde |
| B: Geometrie und Maße erkennen | ✅ | Form aus der Skizze, Maße aus dem Text |
| B: Gezielt nachfragen | 🟡 | per Agent-Regel. Rückfragen kommen als Text, ohne Antwort-Knöpfe. Kein gezielter Test. |
| B: Parametrisch konstruieren | ✅ | benannte Parameter für Hauptmaße |
| B: Sofort in SolidCraft zeigen | ✅ | Der Agent arbeitet in der laufenden App, das Tablet lädt nach jeder Änderung neu. |
| C: Drehen und zoomen | ✅ | |
| C: Auf dem Modell zeichnen, Kanten und Flächen markieren | ✅ | 3D-Anker aus Raycast. Kante eingekreist und gerundet (Test). |
| C: Neue Elemente skizzieren | 🟡 | per Strich und Beschreibung, ohne native Skizze (siehe Schwerpunkt 3) |
| C: Fortlaufende Änderung statt Neubau | ✅ | Runde 2 ändert das Modell aus Runde 1 |
| Skizzen mit Kameraperspektive speichern | ✅ | pro Runde Bild und JSON (Text, Striche, 3D-Treffer, Kamera) in `<Projekt>.studio/` |
| Vollbild, Werkzeugleiste, KI-Dialog, Undo/Redo | ✅ | |
| MCP geprüft, gezielt erweitert | ✅ / – | Der vorhandene MCP-Server reicht bisher, SolidCraft musste nicht geändert werden. |
| Unabhängig vom CAD-Kern | ✅ | Eigenständiges Repo, nur Steuerkanal und MCP |
| Originale nicht überschreiben | 🟡 | implementiert (Kopie in den Studio-Ordner), nicht automatisch getestet |
| Jede Änderung rückgängig | ✅ / 🟡 | Undo/Redo der App. „KI-Runde zurück“ über Checkpoint ist implementiert, nicht automatisch getestet. |
| Agent nur mit vorgesehenen CAD-Funktionen | ✅ | Claude Code ohne eingebaute Werkzeuge, nur SolidCraft-MCP. save/export/open/new_design gesperrt, Pfade auf den Studio-Ordner begrenzt. |
| Keine API-Schlüssel im Browser | ✅ | Claude Code nutzt die Anmeldung auf dem PC. |
| Nicht ungeschützt im Internet | ✅ | nur 127.0.0.1, Host-Prüfung, Zugangsschlüssel |
| Lokales KI-Modell | ⛔ | Umschalter Online/Lokal ist implementiert. qwen3:8b auf 8 GB baute im Test nichts. Zurückgestellt bis mehr Grafikspeicher (16–24 GB) verfügbar ist. |

## Testprotokoll

| Datum | Test | Ergebnis |
|---|---|---|
| 18.11.2026 | E2E automatisch (Chrome, Maus): Skizze + Text → Platte mit Bohrungen, Kante einkreisen → R 8, speichern | bestanden. Runden 16 s bzw. 9 s. |
| 18.11.2026 | Spracherkennung mit 4 deutschen Aufnahmen (Wikimedia Commons) | 4/4 richtig, 0,3 s |
| 18.11.2026 | Mikrofon-Knopf im Testbrowser (Attrappe mit Aufnahme) | Text erscheint im Feld |
| 18.11.2026 | Lokaler Agent qwen3:8b (Ollama), gleiche Aufgabe | **nicht bestanden**: kein Bauteil, 2,5 min. Mit Denkmodus Zeitüberschreitung. |
| 18.11.2026 | Bedienung auf dem Galaxy Tab S8+ durch den Benutzer: zeichnen, einkreisen, senden, Sprache | funktioniert. Fehler „Tablet zeigt alten Stand“ gefunden und behoben. |
| 19.11.2026 | `tests/funktionstest --smoke` | bestanden (5/5) |
| 19.11.2026 | `tests/funktionstest --full` (getrennte Test-Instanz) | bestanden (7/7), Volumen exakt |

### Letzter Volltest

19.11.2026, `node funktionstest.mjs --full` gegen eine getrennte Test-Instanz (SolidCraft auf
Port 7980, Studio auf 8766, eigener Projektordner):

```
OK   WebSocket-Verbindung zum Studio steht
OK   Oberfläche geladen (three.js, Testschnittstelle)
OK   Neues, leeres Bauteil
OK   Runde 1: Platte mit Bohrungen, Volumen 11762 mm³ (Soll 11762)
     KI: Die Grundplatte ist fertig: 60 × 40 × 5 mm, mittig um den Ursprung, Unterseite auf Z = 0. Sie hat
         zwei durchgehende Bohrungen Ø 5,5 mm mit 36 mm Abstand …
OK   Runde 2: eingekreiste Kante R 8 gerundet, Volumen 11694 mm³ (Soll 11694)
     KI: Die markierte senkrechte Eckkante hinten rechts (Ecke bei X +30 / Y +20) hat jetzt eine Rundung
         mit R 8. Die anderen drei Ecken sind weiter scharfkantig.
OK   Gespeichert: …/Funktionstest.sc
Alle Prüfungen bestanden.
```

## Bekannte Fehler und Eigenheiten

- Nach einem Neustart des Studios beginnt der Agent ein neues Gespräch, das Modell bleibt erhalten.
- Alle verbundenen Oberflächen teilen sich einen Agenten. Gedacht ist ein Tablet zur Zeit.
- Die Tablet-Ansicht ist ein Netz-Export (GLB): keine Skizzen, Achsen oder Bemaßungen aus SolidCraft.
- `faster-whisper` 1.2.1 verträgt PyAV ≥ 15 nicht beim Dateiöffnen. Das Studio dekodiert deshalb selbst
  (`stt.py::_decode`).
- Firefox für Android schickt ein `SameSite=Strict`-Cookie nach einem aus einer App geöffneten Redirect
  nicht mit. Deshalb gibt es keinen Redirect, und das Cookie ist `Lax`.
- Im automatischen Test blieb einmal ein Strich nach dem Senden sichtbar. Das ließ sich nicht
  nachstellen.

## Nächste Schritte (Priorität)

1. **S-Pen-Test** nach Prüfliste ([docs/FUNKTIONSTEST.md](docs/FUNKTIONSTEST.md), Teil B), Fehler beheben, Strich-Undo
2. **Linienfarben mit Bedeutung** (Schwerpunkt 1): Farbpalette, Farbe je Strich im Kontext,
   Legende per Sprache („Blau ist Schnittkante“), in der Sitzung und im Projekt gespeichert
3. **Vektorisierung** (2): Striche serverseitig in Linien, Bögen und Kreise zerlegen (z. B.
   Ramer-Douglas-Peucker + Kreis-Fit), mit Bild und 3D-Ankern an den Agenten
4. **Native bemaßte Skizzen** (3): erkannte Elemente als SolidCraft-Skizze mit Bedingungen, Maße aus
   Sprache und Text, dof 0 prüfen. Die Skizze ist danach in SolidCraft bearbeitbar.
5. **Sprachausgabe** (5): Piper lokal, Vorlesen ein/aus, Rückfragen per Sprache beantworten
6. **WLAN-Betrieb** (6): HTTPS, LAN-Bindung nur nach Opt-in, Kopplung per QR-Code
7. Fotoimport von Papierskizzen, Antwort-Knöpfe für Rückfragen, Hervorhebung vor Änderungen

## Für die nächste Sitzung

- Projektregeln: [CLAUDE.md](CLAUDE.md)
- Einstieg in den Code: `studio/server.py` (Ablauf und Befehle vom Tablet), `web/app.js`
  (Ansicht, Stift, Sprache), `studio/agent.py` (Systemanweisung des Agenten)
- Vor Änderungen den Smoke-Test laufen lassen, danach Smoke- und bei Agent-Änderungen den Volltest
  (gegen eine Test-Instanz, siehe docs/FUNKTIONSTEST.md)
