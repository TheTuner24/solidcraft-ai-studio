"""KI-Agent: ein langlebiger Claude-Code-Prozess im Headless-Modus.

Claude Code bekommt keine eingebauten Werkzeuge (kein Bash, keine Dateien), nur den
SolidCraft-MCP-Server, der mit der laufenden App verbunden ist. Ein- und Ausgabe laufen als
stream-json, so bleibt eine Unterhaltung über viele Runden im selben Prozess.
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
from pathlib import Path
from typing import Awaitable, Callable

log = logging.getLogger("studio.agent")

SYSTEM_PROMPT = """\
Du bist der Konstrukteur im SolidCraft AI Studio. Der Benutzer arbeitet an einem Tablet mit Stift
und beschreibt, was er will; du baust und änderst das parametrische Modell in der laufenden
SolidCraft-App mit den SolidCraft-Werkzeugen. Antworte immer auf Deutsch, knapp.

Arbeitsweise:
- Lade vor der ersten Konstruktion `skill_reference {"skill":"solidcraft-modeling"}` und sieh mit
  `inspect_design` nach, was schon da ist. Das Modell entwickelt sich fortlaufend: ändere das
  vorhandene Modell, baue es nicht neu.
- Skizzen zeigen Form und Lage, Maße kommen aus dem Text. Lies keine Maße aus der Freihandskizze.
- Fehlen wesentliche Angaben (Maß, Lage, Anzahl) oder widersprechen sie sich, frag gezielt nach,
  statt zu raten, und ändere dann nichts. Kleinigkeiten mit üblichem Standard (z. B. Bohrung
  durchgehend) darfst du annehmen, sag sie aber in einem Satz.
- Benenne Features, nutze Parameter für Hauptmaße, prüfe jedes Ergebnis mit `measure` und
  korrigiere Fehler selbst.
- Markierungen des Benutzers kommen als 3D-Weltpunkte (mm, Z oben) mit Flächennormale. Nutze diese
  Punkte als Picks (`edges: [[x,y,z]]`, `faces: [[x,y,z]]`). Eine eingekreiste Kante liegt dort, wo
  die Punkte zweier Flächen mit verschiedener Normale aneinanderstoßen; im Zweifel prüfe mit
  `body_topology` und frag nach, wenn mehrere Kanten in Frage kommen.
- Speichern, Exportieren und Dateien öffnen übernimmt das Studio. Tu das nicht selbst.
- Schließe jede Runde mit einem Satz ab, was du geändert hast (oder was du wissen musst).
"""


class Agent:
    def __init__(self, control_port: int, allow_dir: Path, on_event: Callable[[dict], Awaitable[None]],
                 model: str | None = None):
        self.control_port = control_port
        self.allow_dir = allow_dir
        self.on_event = on_event
        self.model = model
        self.proc: asyncio.subprocess.Process | None = None
        self.session_id: str | None = None
        self.busy = False
        self._reader_task: asyncio.Task | None = None
        self._turn_done: asyncio.Event = asyncio.Event()

    def _mcp_config(self) -> str:
        cli = shutil.which("solidcraft-cli") or str(Path.home() / ".local/bin/solidcraft-cli")
        return json.dumps({"mcpServers": {"solidcraft": {
            "type": "stdio",
            "command": cli,
            "args": ["mcp", "--connect", f"127.0.0.1:{self.control_port}",
                     "--allow-path", str(self.allow_dir), "--param-check", "warn"],
        }}})

    async def start(self) -> None:
        claude = shutil.which("claude")
        if not claude:
            raise RuntimeError("claude (Claude Code) nicht gefunden")
        args = [claude, "-p", "--input-format", "stream-json", "--output-format", "stream-json",
                "--verbose", "--strict-mcp-config", "--mcp-config", self._mcp_config(),
                "--tools", "", "--allowedTools", "mcp__solidcraft",
                "--disallowedTools", "mcp__solidcraft__save", "mcp__solidcraft__export",
                "mcp__solidcraft__open", "mcp__solidcraft__new_design",
                "--permission-mode", "dontAsk", "--append-system-prompt", SYSTEM_PROMPT]
        if self.model:
            args += ["--model", self.model]
        if self.session_id:
            args += ["--resume", self.session_id]
        self.allow_dir.mkdir(parents=True, exist_ok=True)
        self.proc = await asyncio.create_subprocess_exec(
            *args, cwd=str(self.allow_dir), stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE, limit=64 * 1024 * 1024)
        self._reader_task = asyncio.create_task(self._read())
        asyncio.create_task(self._stderr())
        log.info("Agent gestartet (pid %s)", self.proc.pid)

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def _stderr(self) -> None:
        assert self.proc and self.proc.stderr
        async for line in self.proc.stderr:
            log.warning("claude: %s", line.decode(errors="replace").rstrip())

    async def _read(self) -> None:
        assert self.proc and self.proc.stdout
        async for raw in self.proc.stdout:
            try:
                ev = json.loads(raw)
            except json.JSONDecodeError:
                continue
            await self._handle(ev)
        if self.busy:
            self.busy = False
            await self.on_event({"kind": "error", "text": "Der Agent wurde beendet."})
        self._turn_done.set()

    async def _handle(self, ev: dict) -> None:
        t = ev.get("type")
        if t == "system" and ev.get("subtype") == "init":
            self.session_id = ev.get("session_id") or self.session_id
            await self.on_event({"kind": "ready", "model": ev.get("model")})
        elif t == "assistant":
            for block in ev.get("message", {}).get("content", []):
                if block.get("type") == "text" and block.get("text", "").strip():
                    await self.on_event({"kind": "text", "text": block["text"]})
                elif block.get("type") == "tool_use":
                    name = block.get("name", "").removeprefix("mcp__solidcraft__")
                    await self.on_event({"kind": "tool", "name": name, "input": block.get("input")})
        elif t == "result":
            self.session_id = ev.get("session_id") or self.session_id
            self.busy = False
            await self.on_event({"kind": "done", "ok": not ev.get("is_error"),
                                 "error": ev.get("result") if ev.get("is_error") else None,
                                 "cost": ev.get("total_cost_usd"), "ms": ev.get("duration_ms")})
            self._turn_done.set()

    async def send(self, content: list[dict]) -> None:
        if self.busy:
            raise RuntimeError("Der Agent arbeitet noch.")
        if not self.running:
            await self.start()
        assert self.proc and self.proc.stdin
        self.busy = True
        self._turn_done.clear()
        msg = {"type": "user", "message": {"role": "user", "content": content}}
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self.proc.stdin.drain()

    async def wait_turn(self) -> None:
        await self._turn_done.wait()

    async def stop(self) -> None:
        """Bricht die laufende Runde ab; die Unterhaltung wird beim nächsten Senden fortgesetzt."""
        if self.running:
            assert self.proc
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), 5)
            except asyncio.TimeoutError:
                self.proc.kill()
        self.busy = False

    async def reset(self) -> None:
        await self.stop()
        self.session_id = None
