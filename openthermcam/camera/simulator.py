"""Synthetic camera for development and tests (no video, temperature frames only)."""

from __future__ import annotations

import math
import threading
import time

import numpy as np

from .. import HEIGHT, WIDTH
from ..frames import encode_temperature
from .base import CameraSource


def synthetic_matrix(t: float) -> np.ndarray:
    yy, xx = np.mgrid[0:HEIGHT, 0:WIDTH].astype(np.float32)
    base = 20.0 + 2.0 * (yy / HEIGHT)
    # a warm "radiator" that slowly pulses and a moving hot spot
    radiator = 18.0 * np.exp(-(((xx - 60) / 30) ** 2 + ((yy - 90) / 50) ** 2)) * (0.8 + 0.2 * math.sin(t / 5))
    hx = WIDTH / 2 + 50 * math.cos(t / 3)
    hy = HEIGHT * 0.7 + 20 * math.sin(t / 3)
    spot = 35.0 * np.exp(-(((xx - hx) / 6) ** 2 + ((yy - hy) / 6) ** 2))
    noise = np.random.default_rng(int(t * 10)).normal(0, 0.15, (HEIGHT, WIDTH))
    return (base + radiator + spot + noise).astype(np.float32)


class SimulatedCamera(CameraSource):
    has_video = False

    def __init__(self, interval: float = 1.2) -> None:
        super().__init__()
        self.interval = interval
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        self._stop.clear()
        self.set_status("connecting", "simulator")
        self._thread = threading.Thread(target=self._run, name="sim-camera", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        self.set_status("stopped")

    def emit_now(self) -> None:
        self._on_sample(encode_temperature(synthetic_matrix(time.time())))

    def _run(self) -> None:
        while not self._stop.is_set():
            self.emit_now()
            self._stop.wait(self.interval)
