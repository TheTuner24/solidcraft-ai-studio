"""Asynchroner Client für den Steuerkanal der laufenden SolidCraft-App.

Protokoll: eine JSON-Zeile pro Anfrage über 127.0.0.1:PORT, erste Anfrage trägt das Token
(docs/control-protocol.md im SolidCraft-Repository).
"""
from __future__ import annotations

import asyncio
import json
import logging
from pathlib import Path
from typing import Any, Awaitable, Callable

log = logging.getLogger("studio.solidcraft")

CONTROL_DIR = Path.home() / ".local/share/solidcraft/control"


class ControlError(RuntimeError):
    pass


def read_token(port: int) -> str:
    path = CONTROL_DIR / f"{port}.token"
    try:
        return path.read_text().strip()
    except FileNotFoundError as e:
        raise ControlError(
            f"Kein Token unter {path}: läuft SolidCraft mit --control {port}?"
        ) from e


class ControlClient:
    """Eine authentifizierte Verbindung; Anfragen werden der Reihe nach beantwortet."""

    def __init__(self, port: int):
        self.port = port
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None
        self._next_id = 0
        self._pending: dict[int, asyncio.Future] = {}
        self._lock = asyncio.Lock()
        self._read_task: asyncio.Task | None = None
        self.on_event: Callable[[str, dict], Awaitable[None]] | None = None

    async def connect(self) -> None:
        self._reader, self._writer = await asyncio.open_connection("127.0.0.1", self.port)
        self._next_id = 0
        self._read_task = asyncio.create_task(self._read_loop())

    @property
    def connected(self) -> bool:
        return self._writer is not None and not self._writer.is_closing()

    async def close(self) -> None:
        if self._writer:
            self._writer.close()
        if self._read_task:
            self._read_task.cancel()
        self._writer = None

    async def _read_loop(self) -> None:
        assert self._reader
        try:
            while True:
                line = await self._reader.readline()
                if not line:
                    break
                msg = json.loads(line)
                if "event" in msg:
                    if self.on_event:
                        asyncio.create_task(self.on_event(msg["event"], msg.get("params") or {}))
                    continue
                fut = self._pending.pop(msg.get("id"), None)
                if fut and not fut.done():
                    fut.set_result(msg)
        except (asyncio.CancelledError, ConnectionError):
            pass
        finally:
            for fut in self._pending.values():
                if not fut.done():
                    fut.set_exception(ControlError("Verbindung zu SolidCraft getrennt"))
            self._pending.clear()
            self._writer = None

    async def call(self, method: str, params: dict | None = None, timeout: float = 600) -> Any:
        async with self._lock:
            if not self.connected:
                await self.connect()
            self._next_id += 1
            rid = self._next_id
            msg: dict[str, Any] = {"id": rid, "method": method, "params": params or {}}
            if rid == 1:
                msg["token"] = read_token(self.port)
            fut = asyncio.get_running_loop().create_future()
            self._pending[rid] = fut
            assert self._writer
            self._writer.write((json.dumps(msg) + "\n").encode())
            await self._writer.drain()
        reply = await asyncio.wait_for(fut, timeout)
        if not reply.get("ok"):
            raise ControlError(reply.get("error", "unbekannter Fehler"))
        return reply.get("result")

    async def execute(self, command: str, params: dict | None = None, timeout: float = 600) -> Any:
        return await self.call("engine.execute", {"command": command, "params": params or {}}, timeout)
