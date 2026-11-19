# Projektregeln für SolidCraft AI Studio

Diese Regeln gelten für jede Weiterentwicklung, egal ob durch Menschen oder KI-Assistenten
(Claude Code, Codex …). `AGENTS.md` verweist hierher.

## Vor dem Arbeiten

1. [STAND.md](STAND.md) lesen. Dort stehen der aktuelle Stand, offene Punkte, bekannte Fehler und
   die nächsten Schritte. Die Anforderungen stehen in [docs/AUFTRAG.md](docs/AUFTRAG.md).
2. Smoke-Test laufen lassen (`tests/funktionstest`, `npm run smoke`), damit der Ausgangszustand bekannt ist.

## Dokumentationspflicht (dauerhaft)

Nach **jedem abgeschlossenen Entwicklungsabschnitt**, also jeder Funktion, Fehlerbehebung oder
Testrunde, die committet wird:

1. **STAND.md aktualisieren:**
   - Datum, betroffene Zeilen in den Abgleich-Tabellen
   - Testprotokoll (Datum, Test, Ergebnis)
   - bekannte Fehler, nächste Schritte
   - Status ehrlich unterscheiden:
     - ✅ implementiert **und getestet** (automatischer Test oder geprüfte Bedienung)
     - 🟡 implementiert, nicht oder nur teilweise getestet
     - 📋 geplant
     - ⛔ zurückgestellt
   - Nichts als getestet markieren, was nicht wirklich gelaufen ist.
2. **README.md (Deutsch) und README.en.md (Englisch)** im Gleichklang halten: Funktionstabelle,
   Start, Optionen, Bedienung.
3. **docs/FUNKTIONSTEST.md** anpassen, wenn sich Ablauf oder Erwartung ändern, und
   `tests/funktionstest/funktionstest.mjs` um neue prüfbare Funktionen erweitern.
4. Dokumentation und Code im **selben Commit oder direkt hintereinander** pushen.

## Was nie ins Repository gehört

- private Infrastruktur: IP-Adressen, Rechnernamen, Heimnetz-Details, interne Dienste, Seriennummern
- Zugangsdaten jeder Art: Tokens, Passwörter, API-Schlüssel, den Studio-Zugangsschlüssel aus
  `.cache/token`, Inhalte von `studio-url.txt`
- persönliche Daten: Namen, E-Mail-Adressen (Commits nur mit der GitHub-noreply-Adresse)
- Benutzerprojekte und Rundenprotokolle (`*.sc`, `*.studio/`)

Vor jedem Push `git diff --cached` auf solche Inhalte prüfen.

## Bestehende Funktion schützen

- Keine Änderung darf vorhandene, als ✅ markierte Funktionen brechen. Nach Änderungen am
  Studio-Dienst oder an der Oberfläche den Smoke-Test ausführen. Nach Änderungen am Agenten, am
  Stift-Kontext oder am Export zusätzlich den Volltest, und zwar **gegen eine getrennte Test-Instanz**
  (siehe docs/FUNKTIONSTEST.md A3), nie gegen die offene Arbeitssitzung des Benutzers.
- Die Testschnittstelle `window.studioDebug` in `web/app.js` bleibt erhalten, der Funktionstest braucht sie.
- SolidCraft nur über Steuerkanal und MCP ansprechen, keine Änderungen am SolidCraft-Kern. Fehlt
  etwas im MCP, das in STAND.md als offene Frage festhalten.
- Sicherheitsgrenzen beibehalten:
  - Dienst nur auf 127.0.0.1, außer der WLAN-Modus wird bewusst eingeschaltet
  - Zugangsschlüssel
  - Agent ohne Shell und Dateien, Pfade auf den Studio-Ordner begrenzt
  - keine API-Schlüssel im Browser
  - Originale nie überschreiben

## Technische Eckpunkte

- Python ≥ 3.11 mit `uv` (`studio/`), Oberfläche ohne Build-Schritt (`web/`, three.js lokal in `web/vendor/`)
- Koordinaten: SolidCraft-Welt, mm, Z oben. GLB-Export kommt in m mit Y oben, die Oberfläche setzt die
  Wurzeltransformation zurück.
- Agent-Ereignisse und Tablet-Befehle laufen über einen WebSocket (`/ws`), das Protokoll steht in
  `studio/server.py::Studio.command` und `web/app.js::handle`.
- Oberfläche und Agentenantworten auf Deutsch. Dokumentation Deutsch, README zusätzlich Englisch.

## Commits

- Commit-Nachrichten auf Deutsch, Betreff kurz und konkret
- Autor: repo-lokal `TheTuner24 <TheTuner24@users.noreply.github.com>`
