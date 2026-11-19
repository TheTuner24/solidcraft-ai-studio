import argparse
import asyncio
import logging
from pathlib import Path

from .server import Studio


def main() -> None:
    ap = argparse.ArgumentParser(prog="studio", description="SolidCraft AI Studio")
    ap.add_argument("--control-port", type=int, default=7979, help="Steuerkanal der SolidCraft-App")
    ap.add_argument("--port", type=int, default=8765, help="Port der Weboberfläche")
    ap.add_argument("--host", default="127.0.0.1", help="nur lokal; das Tablet kommt per adb reverse")
    ap.add_argument("--projects", type=Path, default=Path.home() / "CAD" / "ai-studio")
    ap.add_argument("--model", default=None, help="Claude-Modell (Standard: wie Claude Code)")
    ap.add_argument("--local-model", default="qwen3:8b", help="Ollama-Modell für den Modus „Lokal“")
    ap.add_argument("--no-speech", action="store_true", help="Spracheingabe (Whisper) abschalten")
    ap.add_argument("--no-voice", action="store_true", help="Sprachausgabe (Piper) abschalten")
    a = ap.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
    logging.getLogger("aiohttp.access").setLevel(logging.WARNING)
    try:
        asyncio.run(Studio(a.control_port, a.projects, a.host, a.port, a.model, not a.no_speech, a.local_model, not a.no_voice).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
