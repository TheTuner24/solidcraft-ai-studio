"""Lokaler KI-Agent: ein Ollama-Modell mit Werkzeugaufrufen, dieselben SolidCraft-Werkzeuge wie online.

Gleiche Schnittstelle wie agent.Agent (send, wait_turn, stop, reset, busy, on_event), damit das
Studio zwischen „Online“ (Claude Code) und „Lokal“ (Ollama) umschalten kann.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import time
from pathlib import Path
from typing import Awaitable, Callable

import aiohttp

from .agent import SYSTEM_PROMPT
from .mcp_client import MCPClient

log = logging.getLogger("studio.local")

OLLAMA_URL = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434").rstrip("/")
if not OLLAMA_URL.startswith("http"):
    OLLAMA_URL = "http://" + OLLAMA_URL
# Werkzeuge, die der lokale Agent bekommt: genug zum Konstruieren, wenig Ballast im Kontext.
TOOLS = ["execute", "batch", "inspect_design", "measure", "body_topology", "set_parameter",
         "check_parameters", "undo", "redo", "list_commands", "describe_command"]
MAX_STEPS = 30
MAX_RESULT_CHARS = 4000
NUM_CTX = int(os.environ.get("STUDIO_LOCAL_CTX", "16384"))

LOCAL_EXTRA = """
Du arbeitest nur über Werkzeugaufrufe. Rufe für jede Änderung `batch` oder `execute` mit echten
SolidCraft-Befehlen auf; beschreibe nie nur, was du tun würdest. Die Befehlsreferenz steht unten,
`skill_reference` brauchst du nicht. Prüfe mit `measure`. Sag erst am Ende in ein bis zwei Sätzen, was
anders ist.
"""


class LocalAgent:
    def __init__(self, control_port: int, allow_dir: Path, on_event: Callable[[dict], Awaitable[None]],
                 model: str, think: bool = False):
        self.control_port = control_port
        self.allow_dir = allow_dir
        self.on_event = on_event
        self.model = model
        self.think = think
        self.headless = False   # nur für Tests: eigene SolidCraft-Sitzung statt der App
        self.mcp: MCPClient | None = None
        self.messages: list[dict] = []
        self.system: str | None = None
        self.tools: list[dict] = []
        self.vision = False
        self.busy = False
        self._task: asyncio.Task | None = None
        self._done = asyncio.Event()
        self._done.set()

    async def _ensure(self) -> None:
        if self.mcp and self.mcp.running:
            return
        cli = shutil.which("solidcraft-cli") or str(Path.home() / ".local/bin/solidcraft-cli")
        target = ["--headless"] if self.headless else ["--connect", f"127.0.0.1:{self.control_port}"]
        self.mcp = MCPClient([cli, "mcp", *target,
                              "--allow-path", str(self.allow_dir), "--param-check", "warn", "--compact"])
        await self.mcp.start()
        self.tools = [{"type": "function", "function": {
            "name": t["name"], "description": t.get("description", "")[:1500],
            "parameters": t.get("inputSchema") or {"type": "object", "properties": {}}}}
            for t in self.mcp.tools if t["name"] in TOOLS]
        reference, _ = await self.mcp.call_tool("skill_reference", {"skill": "solidcraft-modeling"})
        self.system = SYSTEM_PROMPT + LOCAL_EXTRA + "\n\n" + reference
        async with aiohttp.ClientSession() as s:
            async with s.post(f"{OLLAMA_URL}/api/show", json={"model": self.model}) as r:
                if r.status != 200:
                    raise RuntimeError(f"Ollama kennt das Modell {self.model} nicht ({r.status}).")
                info = await r.json()
        self.vision = "vision" in (info.get("capabilities") or [])
        await self.on_event({"kind": "ready", "model": f"{self.model} (lokal)"})

    async def send(self, content: list[dict]) -> None:
        if self.busy:
            raise RuntimeError("Der Agent arbeitet noch.")
        self.busy = True
        self._done.clear()
        self._task = asyncio.create_task(self._turn(content))

    async def _turn(self, content: list[dict]) -> None:
        t0 = time.monotonic()
        try:
            await self._ensure()
            text = "\n".join(c["text"] for c in content if c.get("type") == "text")
            images = [c["source"]["data"] for c in content if c.get("type") == "image"]
            msg: dict = {"role": "user", "content": text}
            if images and self.vision:
                msg["images"] = images
            elif images:
                msg["content"] += ("\n\n(Hinweis: Das Bild der Skizze kann dieses Modell nicht sehen. "
                                   "Nutze die 3D-Punkte der Markierungen und den Text.)")
            self.messages.append(msg)
            for _ in range(MAX_STEPS):
                reply = await self._chat()
                self.messages.append(reply)
                if reply.get("content", "").strip():
                    await self.on_event({"kind": "text", "text": reply["content"].strip()})
                calls = reply.get("tool_calls") or []
                if not calls:
                    break
                for call in calls:
                    fn = call.get("function", {})
                    name, args = fn.get("name", ""), fn.get("arguments") or {}
                    if isinstance(args, str):
                        try:
                            args = json.loads(args)
                        except json.JSONDecodeError:
                            args = {}
                    await self.on_event({"kind": "tool", "name": name, "input": args})
                    if name not in TOOLS:
                        result = f"Werkzeug {name!r} gibt es hier nicht. Erlaubt: {', '.join(TOOLS)}"
                    else:
                        try:
                            result, is_err = await self.mcp.call_tool(name, args)
                            if is_err:
                                result = "FEHLER: " + result
                        except Exception as e:  # Werkzeugfehler zurück an das Modell
                            result = f"FEHLER: {e}"
                    if len(result) > MAX_RESULT_CHARS:
                        result = result[:MAX_RESULT_CHARS] + "\n… (gekürzt)"
                    self.messages.append({"role": "tool", "tool_name": name, "content": result})
            else:
                await self.on_event({"kind": "text", "text": f"Ich habe nach {MAX_STEPS} Schritten abgebrochen."})
            self._trim()
            await self.on_event({"kind": "done", "ok": True, "ms": int((time.monotonic() - t0) * 1000)})
        except asyncio.CancelledError:
            await self.on_event({"kind": "done", "ok": False, "error": "abgebrochen"})
        except Exception as e:
            log.exception("Lokaler Agent")
            await self.on_event({"kind": "done", "ok": False, "error": str(e)})
        finally:
            self.busy = False
            self._done.set()

    async def _chat(self) -> dict:
        body = {"model": self.model, "stream": False, "think": self.think, "tools": self.tools,
                "messages": [{"role": "system", "content": self.system}, *self.messages],
                "options": {"num_ctx": NUM_CTX, "temperature": 0.2}, "keep_alive": "30m"}
        timeout = aiohttp.ClientTimeout(total=600)
        async with aiohttp.ClientSession(timeout=timeout) as s:
            async with s.post(f"{OLLAMA_URL}/api/chat", json=body) as r:
                if r.status != 200:
                    raise RuntimeError(f"Ollama: {r.status} {await r.text()}")
                data = await r.json()
        m = data.get("message") or {}
        out = {"role": "assistant", "content": m.get("content", "")}
        if m.get("tool_calls"):
            out["tool_calls"] = m["tool_calls"]
        return out

    def _trim(self) -> None:
        """Alte Runden kürzen, damit der Kontext reicht: ältere Werkzeugergebnisse zusammenfassen."""
        if len(self.messages) > 60:
            self.messages = self.messages[-60:]
            while self.messages and self.messages[0]["role"] != "user":
                self.messages.pop(0)
        for m in self.messages[:-20]:
            if m["role"] == "tool" and len(m["content"]) > 300:
                m["content"] = m["content"][:300] + " …"

    async def wait_turn(self) -> None:
        await self._done.wait()

    async def stop(self) -> None:
        if self._task and not self._task.done():
            self._task.cancel()
            await self._done.wait()
        self.busy = False

    async def reset(self) -> None:
        await self.stop()
        self.messages.clear()
        if self.mcp:
            await self.mcp.close()
            self.mcp = None
