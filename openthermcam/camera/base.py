"""Common camera source behaviour: latest-frame state and listener fan-out."""

from __future__ import annotations

import threading
import time
from dataclasses import dataclass, field
from typing import Callable

import numpy as np

from ..frames import SampleKind, classify, decode_temperature

Listener = Callable[[SampleKind, bytes], None]


@dataclass
class LiveState:
    status: str = "stopped"  # stopped | connecting | streaming | waiting | error
    message: str = ""
    matrix: np.ndarray | None = None  # deg C, (HEIGHT, WIDTH)
    matrix_time: float | None = None
    h264: bytes | None = None
    h264_time: float | None = None
    temp_frames: int = 0
    video_frames: int = 0
    started_at: float = field(default_factory=time.time)


class CameraSource:
    """Base class. Subclasses call ``_on_sample`` for every sample they receive."""

    has_video = True

    def __init__(self) -> None:
        self.state = LiveState()
        self._lock = threading.Lock()
        self._listeners: list[Listener] = []
        self._new_matrix = threading.Condition(self._lock)

    # lifecycle -------------------------------------------------------------
    def start(self) -> None:  # pragma: no cover - overridden
        raise NotImplementedError

    def stop(self) -> None:  # pragma: no cover - overridden
        raise NotImplementedError

    # listeners -------------------------------------------------------------
    def add_listener(self, fn: Listener) -> None:
        with self._lock:
            self._listeners.append(fn)

    def remove_listener(self, fn: Listener) -> None:
        with self._lock:
            if fn in self._listeners:
                self._listeners.remove(fn)

    # state -----------------------------------------------------------------
    def set_status(self, status: str, message: str = "") -> None:
        with self._lock:
            self.state.status = status
            self.state.message = message

    def latest_matrix(self) -> tuple[np.ndarray | None, float | None]:
        with self._lock:
            return self.state.matrix, self.state.matrix_time

    def wait_for_matrix(self, newer_than: float | None, timeout: float = 3.0) -> tuple[np.ndarray | None, float | None]:
        """Block until a matrix newer than ``newer_than`` arrives (or timeout)."""
        deadline = time.time() + timeout
        with self._new_matrix:
            while True:
                t = self.state.matrix_time
                if t is not None and (newer_than is None or t > newer_than):
                    return self.state.matrix, t
                remaining = deadline - time.time()
                if remaining <= 0:
                    return self.state.matrix, t
                self._new_matrix.wait(remaining)

    def _on_sample(self, sample: bytes) -> None:
        kind = classify(sample)
        now = time.time()
        with self._lock:
            if kind is SampleKind.TEMPERATURE:
                try:
                    self.state.matrix = decode_temperature(sample)
                except ValueError:
                    return
                self.state.matrix_time = now
                self.state.temp_frames += 1
                self._new_matrix.notify_all()
            elif kind is SampleKind.H264:
                self.state.h264 = sample
                self.state.h264_time = now
                self.state.video_frames += 1
            else:
                return
            if self.state.status != "streaming":
                self.state.status = "streaming"
                self.state.message = ""
            listeners = list(self._listeners)
        for fn in listeners:
            try:
                fn(kind, sample)
            except Exception:  # a broken listener must never stop capture
                pass
