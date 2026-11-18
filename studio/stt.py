"""Spracherkennung lokal mit faster-whisper auf der GPU (Rückfall: CPU)."""
from __future__ import annotations

import asyncio
import ctypes
import glob
import io
import logging
import os
import site
import time

log = logging.getLogger("studio.stt")

MODEL = os.environ.get("STUDIO_WHISPER_MODEL", "large-v3-turbo")
# Fachwörter als Hinweis für die Erkennung.
PROMPT = ("Konstruktion in CAD: Grundplatte, Bohrung, Durchmesser, Senkung, Gewinde M5, Fase, Rundung, "
          "Radius, Kante, Fläche, Steg, Rippe, Langloch, Tasche, Millimeter, 5,5 mm, 60 mal 40.")


def _preload_cuda_libs() -> None:
    """Die CUDA-Bibliotheken aus den nvidia-*-Paketen laden, bevor ctranslate2 sie sucht."""
    for base in site.getsitepackages():
        for pattern in ("nvidia/cublas/lib/libcublasLt.so.*", "nvidia/cublas/lib/libcublas.so.*",
                        "nvidia/cudnn/lib/libcudnn*.so.*"):
            for lib in sorted(glob.glob(os.path.join(base, pattern))):
                try:
                    ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass


class SpeechToText:
    def __init__(self) -> None:
        self._model = None
        self._lock = asyncio.Lock()
        self.device = None

    def _load(self):
        _preload_cuda_libs()
        from faster_whisper import WhisperModel
        t = time.monotonic()
        try:
            model = WhisperModel(MODEL, device="cuda", compute_type="float16")
            self.device = "cuda"
        except Exception as e:  # keine GPU frei: langsamer, aber es geht
            log.warning("Whisper auf der GPU nicht möglich (%s), nehme die CPU", e)
            model = WhisperModel(MODEL, device="cpu", compute_type="int8")
            self.device = "cpu"
        log.info("Whisper %s geladen (%s) in %.1f s", MODEL, self.device, time.monotonic() - t)
        return model

    async def ensure_loaded(self) -> None:
        async with self._lock:
            if self._model is None:
                self._model = await asyncio.to_thread(self._load)

    @staticmethod
    def _decode(audio: bytes):
        """Beliebiges Browser-Audio (Ogg/WebM Opus, WAV …) → 16 kHz Mono float32."""
        import av
        import numpy as np
        chunks = []
        with av.open(io.BytesIO(audio), mode="r") as container:
            resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
            for frame in container.decode(audio=0):
                for out in resampler.resample(frame):
                    chunks.append(out.to_ndarray().reshape(-1))
            for out in resampler.resample(None):
                chunks.append(out.to_ndarray().reshape(-1))
        if not chunks:
            return np.zeros(0, dtype=np.float32)
        return np.concatenate(chunks).astype(np.float32) / 32768.0

    def _transcribe(self, audio: bytes) -> str:
        samples = self._decode(audio)
        if samples.size < 1600:   # unter 0,1 s
            return ""
        segments, _ = self._model.transcribe(
            samples, language="de", beam_size=5, vad_filter=True,
            initial_prompt=PROMPT, condition_on_previous_text=False)
        return " ".join(s.text.strip() for s in segments).strip()

    async def transcribe(self, audio: bytes) -> tuple[str, float]:
        await self.ensure_loaded()
        t = time.monotonic()
        text = await asyncio.to_thread(self._transcribe, audio)
        return text, time.monotonic() - t
