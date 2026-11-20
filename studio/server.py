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
from .local_agent import LocalAgent
from .sketches import sketch_polylines
from .solidcraft import ControlClient, ControlError
from .stt import SpeechToText
from .tts import TextToSpeech

log = logging.getLogger("studio")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
MAX_IMAGE_BYTES = 8 * 1024 * 1024


class Studio:
    def __init__(self, control_port: int, projects_dir: Path, host: str, port: int,
                 model: str | None, speech: bool = True, local_model: str = "qwen3:8b",
                 voice_out: bool = True):
        self.control_port = control_port
        self.projects_dir = projects_dir
        self.cache_dir = projects_dir / ".cache"
        self.host, self.port = host, port
        self.token = self._load_token()
        self.sc = ControlClient(control_port)          # Befehle
        self.watch = ControlClient(control_port)       # Änderungs-Ereignisse
        self.agents = {
            "online": Agent(control_port, projects_dir, self._agent_event, model),
            "lokal": LocalAgent(control_port, projects_dir, self._agent_event, local_model),
        }
        self.backend = self._load_backend()
        self.clients: set[web.WebSocketResponse] = set()
        self.stt = SpeechToText() if speech else None
        self.tts = TextToSpeech() if voice_out else None
        self.revision: int | None = None
        self.model_rev = 0
        self._export_lock = asyncio.Lock()
        self._export_pending = False
        self.turn_checkpoints: list[str] = []
        self.turn_no = 0
        self.project_path: Path | None = None   # am PC in SolidCraft offene Datei (None = noch ungespeichert)
        self._doc_known = False                  # schon ein Dokument gesehen?
        self._doc_undo = 0                       # Undo-Tiefe beim letzten Blick: unterscheidet Speichern von Öffnen
        self._doc_dirty = None
        self._send_last_sketch = False
        self.log_lines: list[dict] = []          # Verlauf für neu verbundene Tablets
        self.legend: dict[str, str] = {}         # Farbe → Bedeutung, vom Benutzer festgelegt

    @property
    def agent(self):
        return self.agents[self.backend]

    def _load_backend(self) -> str:
        try:
            mode = json.loads((self.cache_dir / "backend.json").read_text()).get("mode")
            return mode if mode in self.agents else "online"
        except (FileNotFoundError, ValueError):
            return "online"

    def backend_info(self) -> dict:
        a = self.agents["lokal"]
        return {"type": "backend", "mode": self.backend, "local_model": a.model}

    async def set_backend(self, mode: str) -> None:
        if mode not in self.agents:
            raise ValueError("Unbekannter Modus")
        self._require_idle()
        if mode == self.backend:
            return
        await self.agent.reset()
        self.backend = mode
        (self.cache_dir / "backend.json").write_text(json.dumps({"mode": mode}))
        note = {"type": "agent", "kind": "text", "text":
                "KI jetzt lokal (" + self.agents["lokal"].model + ", Ollama): nichts verlässt den Rechner."
                if mode == "lokal" else "KI jetzt online (Claude)."}
        self.log_lines.append(note)
        await self.broadcast(self.backend_info())
        await self.broadcast(note)

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
                    await self._design_changed(info)
                    log.info("Mit SolidCraft verbunden (Port %s)", self.control_port)
                else:
                    await self._poll_document()
            except (OSError, ControlError) as e:
                log.warning("SolidCraft nicht erreichbar: %s", e)
                await self.broadcast({"type": "status", "solidcraft": False, "text": str(e)})
            await asyncio.sleep(3)

    async def _poll_document(self) -> None:
        """Öffnen und Speichern passieren am PC. Ein anderes Dokument oder ein neuer Speicherstand löst
        sofort einen Abgleich aus, auch wenn SolidCraft dafür kein Änderungsereignis schickt."""
        doc = await self.sc.call("document.inspect", {"timeline": False, "bodies": False})
        path = Path(doc["path"]).resolve() if doc.get("path") else None
        if not self._doc_known or path != self.project_path or doc.get("dirty") != self._doc_dirty:
            await self.schedule_export()

    async def _follow_document(self, doc: dict) -> None:
        """Das Studio folgt der Datei, die am PC in SolidCraft offen ist."""
        path = Path(doc["path"]).resolve() if doc.get("path") else None
        undo = int(doc.get("undo") or 0)
        self._doc_dirty = doc.get("dirty")
        if self._doc_known and path == self.project_path:
            self._doc_undo = undo
            return
        first = not self._doc_known
        self._doc_known = True
        # Speichern (unter neuem Namen) behält den Änderungsverlauf, Öffnen beginnt bei null.
        same_design = not first and undo > 0 and undo == self._doc_undo
        old_rounds = self._session_dir if hasattr(self, "_session_dir") else \
            (self.project_path.with_suffix(".studio") if self.project_path else None)
        self.project_path = path
        self._doc_undo = undo
        if same_design and path and old_rounds and old_rounds.exists():
            self._carry_rounds(old_rounds, path.with_suffix(".studio"))
            log.info("Gespeichert am PC: %s", path)
            return
        if same_design:
            return
        log.info("Am PC geöffnet: %s", path or "neues, ungespeichertes Bauteil")
        if hasattr(self, "_session_dir"):
            del self._session_dir
        self._load_legend()
        self.turn_checkpoints.clear()
        self.turn_no = 0
        if not first:
            await self.agent.reset()
            self.log_lines.clear()
        await self.broadcast({"type": "reset"})
        await self.broadcast({"type": "legend", "legend": self.legend})
        self._send_last_sketch = True

    def _carry_rounds(self, src: Path, dst: Path) -> None:
        """Rundenprotokolle zum neuen Speicherort mitnehmen (ungespeichert: verschieben, sonst kopieren)."""
        import shutil
        try:
            if src.resolve() == dst.resolve():
                return
            dst.mkdir(parents=True, exist_ok=True)
            n0 = max(self._turn_numbers(dst), default=0)
            for f in sorted(src.iterdir()):
                m = re.fullmatch(r"runde-(\d+)\.(json|jpeg|png)", f.name)
                target = dst / (f"runde-{int(m.group(1)) + n0:03d}.{m.group(2)}" if m else f.name)
                if f.name == "farblegende.json" and target.exists():
                    continue
                (shutil.move if hasattr(self, "_session_dir") else shutil.copy2)(str(f), str(target))
            if hasattr(self, "_session_dir"):
                src.rmdir()
                if not any(src.parent.iterdir()):
                    src.parent.rmdir()
                del self._session_dir
        except OSError as e:
            log.warning("Rundenprotokolle nicht übernommen: %s", e)

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
        await self._follow_document(doc)
        bodies = doc.get("bodies") or []
        self.model_rev += 1
        out = self.cache_dir / "model.glb"
        if bodies:
            tmp = self.cache_dir / "model.tmp.glb"
            await self.sc.execute("file.export", {"path": str(tmp), "format": "glb"})
            tmp.replace(out)
        elif out.exists():
            out.unlink()
        sketches = await self._sketch_lines()
        await self.broadcast({
            "type": "model", "rev": self.model_rev, "empty": not bodies,
            "name": doc.get("name"), "dirty": doc.get("dirty"),
            "undo": doc.get("undo"), "redo": doc.get("redo"),
            "timeline": [{"name": f.get("name"), "type": f.get("type"), "error": f.get("error")}
                         for f in doc.get("timeline") or []],
            "project": str(self.project_path) if self.project_path else None,
            "sketches": sketches,
        })
        if self._send_last_sketch:
            self._send_last_sketch = False
            if (last := self.last_sketch()):
                await self.broadcast(last)

    async def _sketch_lines(self) -> list[dict]:
        """Sichtbare Skizzen als 3D-Linien (der GLB-Export enthält nur Körper)."""
        try:
            doc = await self.sc.call("document.inspect", {"timeline": False, "bodies": False, "sketches": True})
        except ControlError as e:
            log.warning("Skizzen nicht lesbar: %s", e)
            return []
        out = []
        for sk in doc.get("sketches") or []:
            if not sk.get("visible", True):
                continue
            try:
                si = await self.sc.execute("sketch.inspect", {"sketch": sk.get("name") or sk.get("id")})
            except ControlError as e:
                log.warning("Skizze %s nicht lesbar: %s", sk.get("name"), e)
                continue
            lines = sketch_polylines(si)
            if lines:
                # Ebene mitgeben: Stiftstriche auf der Skizze haften dann an ihr (auch ohne Körper).
                out.append({"name": sk.get("name"), "lines": lines, "plane": si.get("plane")})
        return out

    # ---------- Agent ----------

    LEGEND_RE = re.compile(r"<farblegende>\s*(\{.*?\})\s*</farblegende>", re.S)

    async def _agent_event(self, ev: dict) -> None:
        if ev["kind"] == "text":
            # Der Agent meldet die vom Benutzer festgelegten Farbbedeutungen als Markierung im Text.
            m = self.LEGEND_RE.search(ev["text"])
            if m:
                try:
                    legend = json.loads(m.group(1))
                    if isinstance(legend, dict):
                        await self.set_legend({str(k).lower(): str(v) for k, v in legend.items() if v})
                except ValueError:
                    log.warning("Farblegende nicht lesbar: %s", m.group(1))
                text = self.LEGEND_RE.sub("", ev["text"]).strip()
                if not text:
                    return
                ev = {**ev, "text": text}
        msg = {"type": "agent", **ev}
        if ev["kind"] in ("text", "tool", "error", "done"):
            self.log_lines.append(msg)
            self.log_lines = self.log_lines[-200:]
        await self.broadcast(msg)
        if ev["kind"] == "done":
            await self.schedule_export()

    async def set_legend(self, legend: dict[str, str]) -> None:
        self.legend = legend
        try:
            (self._turn_dir() / "farblegende.json").write_text(json.dumps(legend, ensure_ascii=False, indent=1))
        except OSError as e:
            log.warning("Farblegende nicht gespeichert: %s", e)
        await self.broadcast({"type": "legend", "legend": legend})

    def _load_legend(self) -> None:
        self.legend = {}
        if self.project_path:
            f = self.project_path.with_suffix(".studio") / "farblegende.json"
            try:
                self.legend = json.loads(f.read_text())
            except (FileNotFoundError, ValueError):
                pass

    async def prompt(self, data: dict) -> None:
        text = (data.get("text") or "").strip()
        image = data.get("image")
        if not text and not image:
            return
        turn_dir = self._turn_dir()
        # Fortlaufend je Ordner zählen: Nach einem Neustart des Studios dürfen alte Runden nicht
        # überschrieben werden.
        self.turn_no = max([self.turn_no, *self._turn_numbers(turn_dir)]) + 1
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
            "farben_in_dieser_runde": sorted({m.get("farbe") for m in data.get("marks") or [] if m.get("farbe")}),
            "farblegende_bisher": self.legend,
            "hinweis": ("Bild: Tablet-Ansicht mit den farbigen Stiftstrichen des Benutzers. "
                        "Markierungen: pro Strich Farbe und 3D-Treffer (Welt-mm, Z oben). auf=modell: Körperfläche "
                        "(body = Körper); auf=skizze: genau auf einer Skizzenlinie, auf=skizzenebene: in der Ebene "
                        "einer Skizze (body = Skizzenname); auf=boden: Z=0. "
                        "Farbbedeutungen legt nur der Benutzer fest (Text dieser oder früherer Runden, "
                        "farblegende_bisher)."),
        }
        record = {"zeit": datetime.now().isoformat(timespec="seconds"), "text": text, **context}
        sketch = data.get("sketch")
        if isinstance(sketch, dict) and isinstance(sketch.get("strokes"), list):
            # Vollständige Striche (nur für das Wiederherstellen, nicht für den Agenten).
            record["skizze"] = sketch
        (turn_dir / f"runde-{self.turn_no:03d}.json").write_text(json.dumps(
            record, ensure_ascii=False, indent=1))
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

    @staticmethod
    def _turn_numbers(d: Path) -> list[int]:
        out = []
        for f in d.glob("runde-*.json"):
            m = re.fullmatch(r"runde-(\d+)\.json", f.name)
            if m:
                out.append(int(m.group(1)))
        return out

    def last_sketch(self) -> dict | None:
        """Letzte Runde mit Skizze des offenen Projekts, damit man dort weitermachen kann."""
        if not self.project_path:
            return None
        d = self.project_path.with_suffix(".studio")
        rounds = []
        for n in self._turn_numbers(d):
            try:
                rounds.append((n, json.loads((d / f"runde-{n:03d}.json").read_text())))
            except (OSError, ValueError):
                continue
        # Nach Zeit, nicht nach Nummer: ältere Studio-Versionen haben nach einem Neustart wieder bei 001
        # angefangen.
        rounds.sort(key=lambda nr: (str(nr[1].get("zeit", "")), nr[0]), reverse=True)
        for n, r in rounds:
            if not (r.get("skizze") or r.get("markierungen")):
                continue
            unsaved = False
            try:
                saved = datetime.fromtimestamp(self.project_path.stat().st_mtime)
                unsaved = datetime.fromisoformat(r["zeit"]) > saved
            except (OSError, KeyError, ValueError):
                pass
            return {"type": "last_sketch", "runde": n, "zeit": r.get("zeit"), "text": r.get("text", ""),
                    "kamera": r.get("kamera"), "skizze": r.get("skizze"),
                    "markierungen": None if r.get("skizze") else r.get("markierungen"),
                    "unsaved": unsaved}
        return None

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
            elif t == "backend":
                await self.set_backend(data.get("mode", ""))
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

    async def _load_tts(self) -> None:
        try:
            await self.tts.ensure_loaded()
        except Exception as e:
            log.warning("Sprachausgabe nicht verfügbar: %s", e)
            self.tts = None
            await self.broadcast(self.capabilities())

    def capabilities(self) -> dict:
        return {"type": "caps", "stt": self.stt is not None, "tts": self.tts is not None}

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
        if self.tts and self.tts.is_echo(text):
            log.info("Eigene Sprachausgabe im Mikrofon erkannt, verworfen: %s", text)
            return web.json_response({"text": "", "echo": True, "seconds": round(secs, 2)})
        log.info("Sprache erkannt in %.2f s: %s", secs, text)
        return web.json_response({"text": text, "seconds": round(secs, 2)})

    async def speak(self, request: web.Request) -> web.Response:
        if not self.tts:
            raise web.HTTPNotFound(text="Sprachausgabe ist abgeschaltet.")
        data = await request.json()
        text = str(data.get("text") or "")
        if not text.strip():
            raise web.HTTPBadRequest(text="Kein Text.")
        try:
            wav = await self.tts.synthesize(text)
        except Exception as e:
            log.exception("Sprachausgabe fehlgeschlagen")
            return web.json_response({"error": f"Sprachausgabe fehlgeschlagen: {e}"}, status=500)
        return web.Response(body=wav, content_type="audio/wav")

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
        await ws.send_json(self.backend_info())
        await ws.send_json({"type": "legend", "legend": self.legend})
        await ws.send_json(self.capabilities())
        if self.revision is not None:
            await self.schedule_export()
        # Frisch gestartetes Studio mit offenem Projekt: letzte Skizze zum Weitermachen anbieten.
        if not self.log_lines and (last := self.last_sketch()):
            await ws.send_json(last)
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
        app.router.add_post("/tts", self.speak)
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
        if self.tts:
            asyncio.create_task(self._load_tts())
        while True:
            await asyncio.sleep(3600)
