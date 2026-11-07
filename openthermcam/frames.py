"""Classify and decode samples coming out of the camera's UVC stream.

The camera has a single UVC format (H.264, 256x342). Interleaved with the video,
roughly every 1.2 s, it sends a radiometric sample:

    10 bytes marker  FF 00 FF 00 FF 00 FF 00 FF 00
    192 x 256 uint16 little-endian, row-major, portrait orientation
    temperature [deg C] = value / 10 - 273.15

See docs/PROTOCOL.md.
"""

from __future__ import annotations

from enum import Enum

import numpy as np

from . import HEIGHT, WIDTH

TEMP_MARKER = bytes.fromhex("ff00ff00ff00ff00ff00")
TEMP_FRAME_SIZE = len(TEMP_MARKER) + WIDTH * HEIGHT * 2
H264_START = (b"\x00\x00\x00\x01", b"\x00\x00\x01")
KELVIN_OFFSET = 273.15


class SampleKind(str, Enum):
    H264 = "h264"
    TEMPERATURE = "temperature"
    EMPTY = "empty"
    UNKNOWN = "unknown"


def classify(sample: bytes) -> SampleKind:
    if sample.startswith(TEMP_MARKER) and len(sample) >= TEMP_FRAME_SIZE:
        return SampleKind.TEMPERATURE
    if sample.startswith(H264_START):
        return SampleKind.H264
    if not any(sample[:64]):
        return SampleKind.EMPTY
    return SampleKind.UNKNOWN


def decode_raw(sample: bytes) -> np.ndarray:
    """Return the raw uint16 (deci-kelvin) matrix, shape (HEIGHT, WIDTH)."""
    if not sample.startswith(TEMP_MARKER):
        raise ValueError("not a temperature sample")
    payload = sample[len(TEMP_MARKER) : TEMP_FRAME_SIZE]
    if len(payload) != WIDTH * HEIGHT * 2:
        raise ValueError(f"temperature sample too short: {len(sample)} bytes")
    return np.frombuffer(payload, dtype="<u2").reshape(HEIGHT, WIDTH)


def raw_to_celsius(raw: np.ndarray) -> np.ndarray:
    return (raw.astype(np.float32) / 10.0 - KELVIN_OFFSET).astype(np.float32)


def decode_temperature(sample: bytes) -> np.ndarray:
    """Return the temperature matrix in deg C (float32, shape (HEIGHT, WIDTH))."""
    return raw_to_celsius(decode_raw(sample))


def encode_temperature(celsius: np.ndarray) -> bytes:
    """Inverse of decode_temperature (used by the simulator and tests)."""
    raw = np.clip(np.round((celsius + KELVIN_OFFSET) * 10.0), 0, 65535).astype("<u2")
    return TEMP_MARKER + raw.tobytes()
