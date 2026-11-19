# Entwicklungsauftrag (Zusammenfassung)

Verbindliche Anforderungen an SolidCraft AI Studio, zusammengefasst aus dem ursprünglichen Auftrag
(November 2026) und den späteren Präzisierungen. Der Abgleich mit dem Ist-Stand steht in
[STAND.md](../STAND.md).

## Ziel

Eine Erweiterung für das Open-Source-CAD [SolidCraft](https://github.com/tangency-labs/solidcraft).
Damit skizziert ein Benutzer technische Bauteile auf einem Tablet mit Stift (Samsung Galaxy Tab S8+,
S Pen), beschreibt sie in natürlicher Sprache und entwickelt sie gemeinsam mit einem KI-Agenten
schrittweise zu **echten, bearbeitbaren, parametrischen 3D-Modellen**. Es geht nicht um KI-generierte
Bilder. Die Zusammenarbeit soll sich anfühlen wie mit einem menschlichen Konstrukteur: Der Mensch
zeichnet, erklärt, korrigiert und entscheidet. Die KI konstruiert.

## Arbeitsablauf

**Phase A – Freies Skizzieren:**
- mit dem S Pen freihändig zeichnen
- Maße und Beschriftungen ergänzen
- vorhandene Zeichnungen öffnen
- Fotos von Papierskizzen importieren
- korrigieren und löschen

Die Zeichenfläche ist für den Stift optimiert.

**Phase B – Sprachgestützte Konstruktion:**
- Skizze und Sprache gemeinsam interpretieren
- Geometrie und Maße erkennen
- bei fehlenden oder widersprüchlichen Angaben gezielt nachfragen
- parametrisch konstruieren
- das Ergebnis sofort in SolidCraft zeigen

**Phase C – Interaktive Weiterentwicklung:**
- Modell auf dem Tablet drehen und zoomen
- auf dem Modell zeichnen, Kanten und Flächen markieren
- neue Elemente skizzieren
- Änderungen per Sprache beschreiben

Beispiel: Kante einkreisen, „Rundung 8 mm“ sagen. Das Modell entwickelt sich fortlaufend und wird
nicht jedes Mal neu erstellt.

## Integration

- vorhandene SolidCraft-Funktionen nutzen: Weboberfläche, Kern, MCP, Skizzen, Rendering, Dateien
- die KI-Erweiterung möglichst unabhängig vom CAD-Kern halten, damit Updates integrierbar bleiben
- MCP gezielt erweitern, wo Operationen fehlen

## Tablet-Bedienung

- **S Pen:** zeichnen, markieren, radieren, Maße ergänzen, Stift und Finger unterscheiden
- **Finger:** drehen, verschieben, zoomen
- **Sprache:** natürliche Unterhaltung, CAD-Änderungen, Rückfragen und Bestätigungen
- **Darstellung:** Vollbild, 3D-Modell, transparente Zeichenebene, Werkzeugleiste, KI-Dialog, Undo/Redo
- Skizzen werden mit Kameraperspektive gespeichert

## KI-Agent

- Er nutzt die SolidCraft-Schnittstellen und hat Zugriff auf Modell, Parameter, Historie, Auswahl,
  Kamera, Stiftmarkierungen, Sprache und Projektdateien.
- Er führt Änderungen aus, prüft sie und korrigiert sie selbst.
- Unklare Konstruktionsentscheidungen erfindet er nicht stillschweigend.

## Sicherheit und Zuverlässigkeit

- Originale werden nicht unbeabsichtigt überschrieben.
- Jede Änderung lässt sich rückgängig machen.
- Operationen werden geprüft.
- Der Agent darf nur die vorgesehenen CAD-Funktionen nutzen.
- Keine unnötigen Rechte.
- Fehler führen nicht zum Verlust der Konstruktion.
- Keine API-Schlüssel im Browser.
- Der Dienst ist nicht ungeschützt im Internet erreichbar.

## Erster Meilenstein (End-to-End)

1. SolidCraft starten
2. Tablet-Oberfläche öffnen
3. Mit dem Stift skizzieren
4. Skizze und Text an den Agenten übergeben
5. Echtes parametrisches Bauteil erzeugen
6. Anzeige auf PC und Tablet
7. Änderung markieren und beschreiben
8. Modell entsprechend ändern
9. Speichern

## Präzisierte Schwerpunkte (19.11.2026)

1. Verschiedene **Linienfarben**, deren Bedeutung der Benutzer **dynamisch per Sprache** festlegt
2. Kombination aus **bildbasierter und vektorbasierter** Skizzenverarbeitung
3. Umwandlung handgezeichneter Geometrie in **native, bemaßte, bearbeitbare CAD-Skizzen**
4. **Zuverlässige S-Pen-Bedienung**
5. **Bidirektionale Sprachkommunikation**: sprechen und Antworten hören
6. **Drahtlose Tablet-Anbindung** ohne USB-Zwang
7. **Vollständige, nachvollziehbare Dokumentation** auf GitHub

## Rahmen

- Open Source (MIT), bevorzugt Open-Source-Komponenten, modular, sparsam, plattformunabhängig
- KI-Backend vorerst Claude Code; ein lokales Modell erst mit ausreichend Grafikspeicher
- Dokumentation ohne private Infrastrukturdaten und ohne Zugangsdaten
