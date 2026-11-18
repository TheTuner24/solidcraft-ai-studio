"""Webdienst des Studios: Tablet-Oberfläche, WebSocket, Modell-Export und Agent-Steuerung."""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
import secrets
import time
from datetime import datetime
from pathlib import Path

from aiohttp import WSMsgType, web

from .agent import Agent
from .solidcraft import ControlClient, ControlError
from .stt import SpeechToText

log = logging.getLogger("studio")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_IMAGE_BYTES = 8 * 1024 * 1024


def safe_name(name: str) -> str:
    name = re.sub(r"[^\w\- ]+", "", name, flags=re.UNICODE).strip().replace(" ", "_")
    return name[:60] or "Bauteil"


class Studio:
    def __init__(self, control_port: int, projects_dir: Path, host: str, port: int,
                 model: str | None, speech: bool = True):
        self.control_port = control_port
        self.projects_dir = projects_dir
        self.cache_dir = projects_dir / ".cache"
        self.host, self.port = host, port
        self.token = self._load_token()
        self.sc = ControlClient(control_port)          # Befehle
        self.watch = ControlClient(control_port)       # Änderungs-Ereignisse
        self.agent = Agent(control_port, projects_dir, self._agent_event, model)
        self.clients: set[web.WebSocketResponse] = set()
        self.stt = SpeechToText() if speech else None
        self.revision: int | None = None
        self.model_rev = 0
        self._export_lock = asyncio.Lock()
        self._export_pending = False
        self.turn_checkpoints: list[str] = []
        self.turn_no = 0
        self.project_path: Path | None = None   # Datei im Studio-Ordner, in die gespeichert wird
        self.log_lines: list[dict] = []          # Verlauf für neu verbundene Tablets

    def _load_token(self) -> str:
        """Bleibt über Neustarts gleich, damit das Tablet angemeldet bleibt (Datei nur für den Benutzer)."""
        path = self.cache_dir / "token"
        try:
            tok = path.read_text().strip()
            if len(tok) >= 24:
                return tok
        except FileNotFoundError:
            pass
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        tok = secrets.token_urlsafe(24)
        path.write_text(tok)
        path.chmod(0o600)
        return tok

    # ---------- Verbindung zu SolidCraft ----------

    async def start_watch(self) -> None:
        while True:
            try:
                if not self.watch.connected:
                    self.watch.on_event = self._on_sc_event
                    info = await self.watch.call("control.subscribe")
                    await self._adopt_open_design()
                    await self._design_changed(info)
                    log.info("Mit SolidCraft verbunden (Port %s)", self.control_port)
            except (OSError, ControlError) as e:
                log.warning("SolidCraft nicht erreichbar: %s", e)
                await self.broadcast({"type": "status", "solidcraft": False, "text": str(e)})
            await asyncio.sleep(3)

    async def _adopt_open_design(self) -> None:
        """Nach einem Neustart des Studios: ein schon offenes Studio-Projekt weiterverwenden."""
        if self.project_path:
            return
        doc = await self.sc.call("document.inspect", {"timeline": False, "bodies": False})
        path = Path(doc["path"]).resolve() if doc.get("path") else None
        if path and path.parent == self.projects_dir.resolve():
            self.project_path = path

    async def _on_sc_event(self, name: str, params: dict) -> None:
        if name == "design.changed":
            await self._design_changed(params)

    async def _design_changed(self, info: dict) -> None:
        self.revision = info.get("revision")
        await self.schedule_export()

    async def schedule_export(self) -> None:
        """Exportiert das Modell als GLB; schnelle Änderungsfolgen werden zusammengefasst."""
        if self._export_lock.locked():
            self._export_pending = True
            return
        async with self._export_lock:
            while True:
                self._export_pending = False
                await asyncio.sleep(0.25)
                try:
                    await self._export_model()
                except (OSError, ControlError) as e:
                    log.warning("Export fehlgeschlagen: %s", e)
                if not self._export_pending:
                    break

    async def _export_model(self) -> None:
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        doc = await self.sc.call("document.inspect", {"timeline": "summary", "bodies": "names"})
        bodies = doc.get("bodies") or []
        self.model_rev += 1
        out = self.cache_dir / "model.glb"
        if bodies:
            tmp = self.cache_dir / "model.tmp.glb"
            await self.sc.execute("file.export", {"path": str(tmp), "format": "glb"})
            tmp.replace(out)
        elif out.exists():
            out.unlink()
        await self.broadcast({
            "type": "model", "rev": self.model_rev, "empty": not bodies,
            "name": doc.get("name"), "dirty": doc.get("dirty"),
            "undo": doc.get("undo"), "redo": doc.get("redo"),
            "timeline": [{"name": f.get("name"), "type": f.get("type"), "error": f.get("error")}
                         for f in doc.get("timeline") or []],
            "project": str(self.project_path) if self.project_path else None,
        })

    # ---------- Agent ----------

    async def _agent_event(self, ev: dict) -> None:
        msg = {"type": "agent", **ev}
        if ev["kind"] in ("text", "tool", "error", "done"):
            self.log_lines.append(msg)
            self.log_lines = self.log_lines[-200:]
        await self.broadcast(msg)
        if ev["kind"] == "done":
            await self.schedule_export()

    async def prompt(self, data: dict) -> None:
        text = (data.get("text") or "").strip()
        image = data.get("image")
        if not text and not image:
            return
        self.turn_no += 1
        turn_dir = self._turn_dir()
        content: list[dict] = []
        if image:
            m = re.match(r"data:image/(png|jpeg);base64,(.+)", image, re.S)
            if not m:
                raise ValueError("Bild nicht lesbar")
            raw = base64.b64decode(m.group(2))
            if len(raw) > MAX_IMAGE_BYTES:
                raise ValueError("Bild zu groß")
            (turn_dir / f"runde-{self.turn_no:03d}.{m.group(1)}").write_bytes(raw)
            content.append({"type": "image", "source": {
                "type": "base64", "media_type": f"image/{m.group(1)}", "data": m.group(2)}})
        context = {
            "kamera": data.get("camera"),
            "markierungen": data.get("marks") or [],
            "hinweis": ("Bild: Tablet-Ansicht mit den Stiftstrichen des Benutzers (rot). "
                        "Markierungen: pro Strich die 3D-Treffer auf dem Modell (Welt-mm, Z oben)."),
        }
        (turn_dir / f"runde-{self.turn_no:03d}.json").write_text(json.dumps(
            {"zeit": datetime.now().isoformat(timespec="seconds"), "text": text, **context},
            ensure_ascii=False, indent=1))
        content.append({"type": "text", "text": (text or "(keine Beschreibung, siehe Skizze)")
                        + "\n\n<studio-kontext>\n" + json.dumps(context, ensure_ascii=False)
                        + "\n</studio-kontext>"})
        try:
            cp = await self.sc.execute("edit.checkpoint")
            self.turn_checkpoints.append(cp["checkpoint"])
            self.turn_checkpoints = self.turn_checkpoints[-15:]
        except ControlError as e:
            log.warning("Checkpoint fehlgeschlagen: %s", e)
        user_msg = {"type": "agent", "kind": "user", "text": text, "marks": len(context["markierungen"])}
        self.log_lines.append(user_msg)
        await self.broadcast(user_msg)
        await self.agent.send(content)
        await self.broadcast({"type": "busy", "busy": True})
        asyncio.create_task(self._after_turn())

    async def _after_turn(self) -> None:
        await self.agent.wait_turn()
        await self.broadcast({"type": "busy", "busy": False})

    def _turn_dir(self) -> Path:
        base = self.project_path.with_suffix(".studio") if self.project_path else \
            self.projects_dir / "sitzungen" / datetime.now().strftime("%Y-%m-%d_%H%M%S")
        if not self.project_path and not hasattr(self, "_session_dir"):
            self._session_dir = base
        d = base if self.project_path else self._session_dir
        d.mkdir(parents=True, exist_ok=True)
        return d

    # ---------- Befehle vom Tablet ----------

    async def command(self, ws: web.WebSocketResponse, data: dict) -> None:
        t = data.get("type")
        try:
            if t == "prompt":
                await self.prompt(data)
            elif t == "stop":
                await self.agent.stop()
                await self.broadcast({"type": "busy", "busy": False})
            elif t in ("undo", "redo"):
                self._require_idle()
                await self.sc.execute(f"edit.{t}")
            elif t == "revert_turn":
                self._require_idle()
                if not self.turn_checkpoints:
                    raise ValueError("Keine KI-Runde zum Zurücknehmen.")
                await self.sc.execute("edit.restore_checkpoint", {"checkpoint": self.turn_checkpoints.pop()})
                await self.agent_note("Die letzte KI-Änderung wurde vom Benutzer zurückgenommen.")
            elif t == "camera":
                cam = data.get("camera") or {}
                await self.sc.call("ui.camera", {k: cam[k] for k in ("target", "yaw", "pitch", "distance") if k in cam})
            elif t == "new":
                self._require_idle()
                await self.sc.execute("file.new", {"name": data.get("name") or "Neues Bauteil"})
                self.project_path = None
                self.turn_checkpoints.clear()
                if hasattr(self, "_session_dir"):
                    del self._session_dir
                await self.agent.reset()
                self.log_lines.clear()
                await self.broadcast({"type": "reset"})
            elif t == "save":
                self._require_idle()
                path = await self.save(data.get("name"))
                await self.broadcast({"type": "saved", "path": str(path)})
                await self.schedule_export()
            elif t == "list":
                await ws.send_json({"type": "files", "files": self.list_designs()})
            elif t == "open":
                self._require_idle()
                await self.open_copy(data.get("path", ""))
            else:
                raise ValueError(f"Unbekannter Befehl {t!r}")
        except (ValueError, RuntimeError, ControlError) as e:
            await ws.send_json({"type": "error", "text": str(e)})

    def _require_idle(self) -> None:
        if self.agent.busy:
            raise RuntimeError("Der Agent arbeitet gerade, bitte warten oder abbrechen.")

    async def agent_note(self, text: str) -> None:
        """Hält den Agenten auf dem Laufenden, ohne eine Runde auszulösen (beim nächsten Prompt)."""
        self._pending_note = text

    async def save(self, name: str | None) -> Path:
        """Speichert nur in den Studio-Ordner; Originaldateien werden nie überschrieben."""
        if self.project_path and not name:
            await self.sc.execute("file.save", {"path": str(self.project_path)})
            return self.project_path
        doc = await self.sc.call("document.inspect", {"timeline": False, "bodies": False})
        base = safe_name(name or doc.get("name") or "Bauteil")
        path = self.projects_dir / f"{base}.sc"
        if path.exists() and path != self.project_path:
            path = self.projects_dir / f"{base}_{datetime.now():%Y%m%d-%H%M%S}.sc"
        await self.sc.execute("file.save_as", {"path": str(path)})
        old_turns = self._session_dir if hasattr(self, "_session_dir") else None
        self.project_path = path
        if old_turns and old_turns.exists():
            target = path.with_suffix(".studio")
            target.mkdir(parents=True, exist_ok=True)
            for f in old_turns.iterdir():
                f.rename(target / f.name)
            old_turns.rmdir()
            if not any(old_turns.parent.iterdir()):
                old_turns.parent.rmdir()
            del self._session_dir
        return path

    def list_designs(self) -> list[dict]:
        roots = [self.projects_dir, self.projects_dir.parent]
        seen, out = set(), []
        for root in roots:
            for p in sorted(root.glob("*.sc"), key=lambda p: p.stat().st_mtime, reverse=True):
                if p in seen:
                    continue
                seen.add(p)
                out.append({"path": str(p), "name": p.stem, "studio": p.parent == self.projects_dir,
                            "mtime": int(p.stat().st_mtime)})
        return out[:50]

    async def open_copy(self, path_str: str) -> None:
        path = Path(path_str).resolve()
        allowed = {self.projects_dir.resolve(), self.projects_dir.parent.resolve()}
        if path.suffix != ".sc" or path.parent not in allowed or not path.is_file():
            raise ValueError("Diese Datei kann das Studio nicht öffnen.")
        await self.sc.execute("doc.open", {"path": str(path)})
        # Dateien außerhalb des Studio-Ordners gelten als Original: gespeichert wird als Kopie.
        self.project_path = path if path.parent == self.projects_dir.resolve() else None
        self.turn_checkpoints.clear()
        await self.agent.reset()
        self.log_lines.clear()
        await self.broadcast({"type": "reset"})
        await self.schedule_export()

    # ---------- Web ----------

    async def broadcast(self, msg: dict) -> None:
        dead = []
        for ws in self.clients:
            try:
                await ws.send_json(msg)
            except (ConnectionError, RuntimeError):
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

    def _authorized(self, request: web.Request) -> bool:
        tok = request.cookies.get("studio") or request.query.get("t")
        return tok is not None and secrets.compare_digest(tok, self.token)

    @web.middleware
    async def guard(self, request: web.Request, handler):
        host = request.host.split(":")[0]
        if host not in ("127.0.0.1", "localhost"):
            raise web.HTTPForbidden(text="Nur lokal erreichbar")
        if request.path.startswith("/vendor/") or request.path in ("/favicon.ico",):
            return await handler(request)
        if not self._authorized(request):
            raise web.HTTPUnauthorized(text="Bitte den Link mit Zugangsschlüssel öffnen (siehe Konsole).")
        resp = await handler(request)
        if request.query.get("t"):
            resp.set_cookie("studio", self.token, httponly=True, samesite="Lax", max_age=86400 * 30)
        return resp

    async def index(self, request: web.Request) -> web.StreamResponse:
        # Kein Redirect: Firefox auf Android behandelt einen per App geöffneten Link als
        # seitenübergreifend und schickt ein Strict-Cookie im Folgeaufruf nicht mit.
        return web.FileResponse(WEB_DIR / "index.html", headers={"Cache-Control": "no-store"})

    async def speech(self, request: web.Request) -> web.Response:
        if not self.stt:
            raise web.HTTPNotFound(text="Spracheingabe ist abgeschaltet.")
        audio = await request.read()
        if not audio or len(audio) > MAX_IMAGE_BYTES:
            raise web.HTTPBadRequest(text="Keine oder zu lange Aufnahme.")
        try:
            text, secs = await self.stt.transcribe(audio)
        except Exception as e:
            log.exception("Spracherkennung fehlgeschlagen")
            return web.json_response({"error": f"Spracherkennung fehlgeschlagen: {e}"}, status=500)
        log.info("Sprache erkannt in %.2f s: %s", secs, text)
        return web.json_response({"text": text, "seconds": round(secs, 2)})

    async def model(self, request: web.Request) -> web.StreamResponse:
        path = self.cache_dir / "model.glb"
        if not path.exists():
            raise web.HTTPNotFound()
        return web.FileResponse(path, headers={"Cache-Control": "no-store",
                                               "Content-Type": "model/gltf-binary"})

    async def websocket(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20, max_msg_size=MAX_IMAGE_BYTES * 2)
        await ws.prepare(request)
        self.clients.add(ws)
        await ws.send_json({"type": "hello", "busy": self.agent.busy, "log": self.log_lines})
        if self.revision is not None:
            await self.schedule_export()
        try:
            async for msg in ws:
                if msg.type == WSMsgType.TEXT:
                    data = json.loads(msg.data)
                    if data.get("type") == "prompt" and getattr(self, "_pending_note", None):
                        data["text"] = f"[{self._pending_note}]\n" + (data.get("text") or "")
                        self._pending_note = None
                    await self.command(ws, data)
        finally:
            self.clients.discard(ws)
        return ws

    @staticmethod
    async def _no_cache(request: web.Request, response: web.StreamResponse) -> None:
        # Nach einem Update soll das Tablet nie eine alte app.js aus dem Cache nehmen.
        if not request.path.startswith("/vendor/"):
            response.headers["Cache-Control"] = "no-cache"

    def app(self) -> web.Application:
        app = web.Application(middlewares=[self.guard], client_max_size=MAX_IMAGE_BYTES * 2)
        app.router.add_get("/", self.index)
        app.router.add_get("/ws", self.websocket)
        app.router.add_get("/model.glb", self.model)
        app.router.add_post("/stt", self.speech)
        app.router.add_static("/", WEB_DIR, show_index=False)
        app.on_response_prepare.append(self._no_cache)
        return app

    async def run(self) -> None:
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        runner = web.AppRunner(self.app())
        await runner.setup()
        site = web.TCPSite(runner, self.host, self.port)
        await site.start()
        url = f"http://localhost:{self.port}/?t={self.token}"
        (self.projects_dir / ".cache").mkdir(exist_ok=True)
        link = self.projects_dir / ".cache" / "studio-url.txt"
        link.write_text(url + "\n")
        link.chmod(0o600)
        print(f"\nSolidCraft AI Studio läuft.\n  Tablet/PC: {url}\n", flush=True)
        asyncio.create_task(self.start_watch())
        if self.stt:
            asyncio.create_task(self.stt.ensure_loaded())   # erste Aufnahme ohne Wartezeit
        while True:
            await asyncio.sleep(3600)
