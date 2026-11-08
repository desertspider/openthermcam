"""Read and write radiometric JPEG files.

Format used by the camera (``DCIM/*-IR.jpg``) and by its Windows viewer software: a normal JPEG,
followed after the EOI marker (FF D9) by a trailer:

    offset 0   uint16 LE  rows (256)
    offset 2   uint16 LE  columns (192)
    offset 4   uint16 LE  unknown (256)
    offset 6   14 bytes   ASCII timestamp YYYYMMDDhhmmss
    offset 20  rows*cols  float32 LE temperatures in deg C (portrait, row-major)
    ...        optional binary block, then a JSON document with measurement settings and ROIs

Note: the header's first two fields read as "256, 192"; the matrix itself is 192 wide and
256 high, matching the camera's portrait display.

OpenThermCam writes the same layout (with its own JSON), so files stay interchangeable.
"""

from __future__ import annotations

import json
import re
import struct
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path

import numpy as np

EOI = b"\xff\xd9"
HEADER_SIZE = 20


@dataclass
class RadiometricImage:
    matrix: np.ndarray  # deg C, (rows, cols)
    jpeg: bytes  # the embedded visual JPEG
    timestamp: datetime | None = None
    meta: dict = field(default_factory=dict)  # parsed JSON trailer (may be empty)

    @property
    def rois(self) -> list[dict]:
        """Measurement points stored in the file, normalised to OpenThermCam point dicts."""
        out = []
        if isinstance(self.meta.get("openthermcam"), dict):
            return list(self.meta["openthermcam"].get("points", []))
        for roi in self.meta.get("roi", []) or []:
            area = roi.get("tempArea") or []
            name = str(roi.get("roiName") or f"P{len(out) + 1}")
            if len(area) == 2:
                out.append({"name": name, "kind": "point", "x": int(area[0]), "y": int(area[1])})
            elif len(area) == 4:
                x1, y1, x2, y2 = (int(v) for v in area)
                out.append({"name": name, "kind": "rect", "x": min(x1, x2), "y": min(y1, y2),
                            "w": abs(x2 - x1) + 1, "h": abs(y2 - y1) + 1})
        return out


def _find_trailer(data: bytes) -> int:
    """Index just after the EOI marker that ends the embedded JPEG."""
    # Prefer an EOI followed by a plausible header (rows/cols both in a sane range).
    pos = data.find(EOI)
    while pos != -1:
        start = pos + 2
        if len(data) >= start + HEADER_SIZE:
            a, b = struct.unpack_from("<HH", data, start)
            if 16 <= a <= 2048 and 16 <= b <= 2048 and len(data) >= start + HEADER_SIZE + a * b * 4:
                return start
        pos = data.find(EOI, pos + 2)
    raise ValueError("no radiometric trailer found")


def is_radiometric(data: bytes) -> bool:
    try:
        _find_trailer(data)
        return True
    except ValueError:
        return False


def parse(data: bytes) -> RadiometricImage:
    start = _find_trailer(data)
    rows, cols = struct.unpack_from("<HH", data, start)
    ts_raw = data[start + 6 : start + 20]
    timestamp = None
    if re.fullmatch(rb"\d{14}", ts_raw):
        try:
            timestamp = datetime.strptime(ts_raw.decode(), "%Y%m%d%H%M%S")
        except ValueError:
            timestamp = None
    mstart = start + HEADER_SIZE
    mend = mstart + rows * cols * 4
    matrix = np.frombuffer(data[mstart:mend], dtype="<f4").reshape(rows, cols)
    meta: dict = {}
    rest = data[mend:]
    brace = rest.find(b"{")
    if brace != -1:
        text = rest[brace:].split(b"\x00", 1)[0].decode("utf-8", "replace")
        try:
            meta = json.loads(text)
        except json.JSONDecodeError:
            meta = {}
    return RadiometricImage(matrix=matrix.astype(np.float32), jpeg=data[:start], timestamp=timestamp, meta=meta)


def read(path: str | Path) -> RadiometricImage:
    return parse(Path(path).read_bytes())


def build(matrix: np.ndarray, jpeg: bytes, timestamp: datetime, meta: dict) -> bytes:
    rows, cols = matrix.shape
    header = struct.pack("<HHH", rows, cols, 256) + timestamp.strftime("%Y%m%d%H%M%S").encode()
    body = np.ascontiguousarray(matrix, dtype="<f4").tobytes()
    return jpeg + header + body + json.dumps(meta, indent=1).encode("utf-8")
