"""Minimaler MCP-Client (JSON-RPC über stdio) für den SolidCraft-MCP-Server."""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

log = logging.getLogger("studio.mcp")


class MCPError(RuntimeError):
    pass


class MCPClient:
    def __init__(self, command: list[str]):
        self.command = command
        self.proc: asyncio.subprocess.Process | None = None
        self._next = 0
        self._pending: dict[int, asyncio.Future] = {}
        self.tools: list[dict] = []

    async def start(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            *self.command, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE, limit=64 * 1024 * 1024)
        asyncio.create_task(self._read())
        asyncio.create_task(self._stderr())
        await self.request("initialize", {
            "protocolVersion": "2025-06-18", "capabilities": {},
            "clientInfo": {"name": "solidcraft-ai-studio", "version": "0.1"}})
        await self._send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        self.tools = (await self.request("tools/list", {})).get("tools", [])

    @property
    def running(self) -> bool:
        return self.proc is not None and self.proc.returncode is None

    async def _stderr(self) -> None:
        assert self.proc and self.proc.stderr
        async for line in self.proc.stderr:
            log.debug("mcp: %s", line.decode(errors="replace").rstrip())

    async def _read(self) -> None:
        assert self.proc and self.proc.stdout
        async for raw in self.proc.stdout:
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError:
                continue
            fut = self._pending.pop(msg.get("id"), None) if "id" in msg else None
            if fut and not fut.done():
                if "error" in msg:
                    fut.set_exception(MCPError(msg["error"].get("message", "MCP-Fehler")))
                else:
                    fut.set_result(msg.get("result") or {})
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(MCPError("MCP-Server beendet"))
        self._pending.clear()

    async def _send(self, msg: dict) -> None:
        assert self.proc and self.proc.stdin
        self.proc.stdin.write((json.dumps(msg) + "\n").encode())
        await self.proc.stdin.drain()

    async def request(self, method: str, params: dict, timeout: float = 900) -> Any:
        self._next += 1
        rid = self._next
        fut = asyncio.get_running_loop().create_future()
        self._pending[rid] = fut
        await self._send({"jsonrpc": "2.0", "id": rid, "method": method, "params": params})
        return await asyncio.wait_for(fut, timeout)

    async def call_tool(self, name: str, arguments: dict) -> tuple[str, bool]:
        """→ (Text der Antwort, ist_fehler). Bilder werden als Hinweis ersetzt."""
        res = await self.request("tools/call", {"name": name, "arguments": arguments})
        parts = []
        for c in res.get("content", []):
            if c.get("type") == "text":
                parts.append(c.get("text", ""))
            else:
                parts.append(f"[{c.get('type')} weggelassen]")
        return "\n".join(parts), bool(res.get("isError"))

    async def close(self) -> None:
        if self.running:
            assert self.proc
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), 5)
            except asyncio.TimeoutError:
                self.proc.kill()
