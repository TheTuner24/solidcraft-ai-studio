"""Sprachausgabe lokal mit Piper (deutsche Stimme), ohne Cloud."""
from __future__ import annotations

import asyncio
import difflib
import io
import logging
import os
import re
import time
import wave
from pathlib import Path

log = logging.getLogger("studio.tts")

VOICE = os.environ.get("STUDIO_PIPER_VOICE", "de_DE-thorsten-medium")
VOICE_DIR = Path(os.environ.get("STUDIO_VOICE_DIR", Path.home() / ".local/share/solidcraft-ai-studio/voices"))
MAX_CHARS = 1500

# Schreibweisen aus CAD-Antworten so umschreiben, dass Piper sie richtig ausspricht.
_REPLACE = [
    (r"`([^`]*)`", r"\1"), (r"\*\*?([^*]+)\*\*?", r"\1"), (r"^#+\s*", ""), (r"^\s*[-•]\s+", ""),
    (r"Ø\s*", "Durchmesser "), (r"\bR\s?(\d)", r"Radius \1"), (r"(\d)\s?mm³", r"\1 Kubikmillimeter"),
    (r"(\d)\s?mm²", r"\1 Quadratmillimeter"), (r"(\d)\s?mm\b", r"\1 Millimeter"), (r"(\d)\s?°", r"\1 Grad"),
    (r"(\d)\s?×\s?(\d)", r"\1 mal \2"), (r"±", "plus minus "), (r"\bz\. ?B\.", "zum Beispiel"),
    (r"\bca\.", "circa"), (r"\bggf\.", "gegebenenfalls"), (r"\bbzw\.", "beziehungsweise"),
]


def speakable(text: str) -> str:
    out = text
    for pat, rep in _REPLACE:
        out = re.sub(pat, rep, out, flags=re.M)
    return re.sub(r"\s+", " ", out).strip()[:MAX_CHARS]


def _words(text: str) -> list[str]:
    return re.findall(r"\w+", text.lower())


class TextToSpeech:
    def __init__(self) -> None:
        self._voice = None
        self._lock = asyncio.Lock()
        self.recent: list[tuple[float, str]] = []   # zuletzt vorgelesen, für die Echo-Erkennung

    def _load(self):
        from piper import PiperVoice
        path = VOICE_DIR / f"{VOICE}.onnx"
        if not path.exists():
            log.info("Lade Piper-Stimme %s nach %s …", VOICE, VOICE_DIR)
            from piper.download_voices import download_voice
            VOICE_DIR.mkdir(parents=True, exist_ok=True)
            download_voice(VOICE, VOICE_DIR)
        t = time.monotonic()
        voice = PiperVoice.load(str(path))
        log.info("Piper-Stimme %s geladen in %.1f s", VOICE, time.monotonic() - t)
        return voice

    async def ensure_loaded(self) -> None:
        async with self._lock:
            if self._voice is None:
                self._voice = await asyncio.to_thread(self._load)

    def _synth(self, text: str) -> bytes:
        buf = io.BytesIO()
        with wave.open(buf, "wb") as w:
            self._voice.synthesize_wav(text, w)
        return buf.getvalue()

    async def synthesize(self, text: str) -> bytes:
        await self.ensure_loaded()
        clean = speakable(text)
        if not clean:
            return b""
        self.recent = [r for r in self.recent if time.monotonic() - r[0] < 120][-5:] + [(time.monotonic(), clean)]
        return await asyncio.to_thread(self._synth, clean)

    def is_echo(self, heard: str) -> bool:
        """Erkennt, ob das Mikrofon gerade die eigene Sprachausgabe aufgenommen hat."""
        h = _words(heard)
        if len(h) < 2:
            return False
        for _, said in self.recent:
            s = _words(said)
            # Anteil der gehörten Wörter, die in derselben Reihenfolge auch vorgelesen wurden
            m = difflib.SequenceMatcher(a=h, b=s, autojunk=False)
            matched = sum(b.size for b in m.get_matching_blocks())
            if matched / len(h) >= 0.7:
                return True
        return False
