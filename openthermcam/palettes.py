"""Colour palettes and rendering of temperature matrices to images."""

from __future__ import annotations

import io

import numpy as np
from PIL import Image

# Control points (position 0..1, RGB). Interpolated to 256-entry lookup tables.
_STOPS: dict[str, list[tuple[float, tuple[int, int, int]]]] = {
    "ironbow": [
        (0.00, (0, 0, 10)), (0.15, (32, 0, 96)), (0.35, (138, 16, 140)), (0.55, (214, 64, 72)),
        (0.72, (247, 128, 16)), (0.88, (255, 204, 32)), (1.00, (255, 255, 230)),
    ],
    "rainbow": [
        (0.00, (0, 0, 128)), (0.20, (0, 64, 255)), (0.40, (0, 220, 220)), (0.60, (64, 220, 64)),
        (0.80, (255, 200, 0)), (1.00, (220, 0, 0)),
    ],
    "white-hot": [(0.0, (0, 0, 0)), (1.0, (255, 255, 255))],
    "black-hot": [(0.0, (255, 255, 255)), (1.0, (0, 0, 0))],
    "lava": [
        (0.00, (8, 8, 24)), (0.30, (40, 40, 120)), (0.50, (150, 40, 90)), (0.70, (240, 90, 40)),
        (0.90, (255, 200, 80)), (1.00, (255, 255, 255)),
    ],
    # diverging, for difference images: blue = colder, white = equal, red = warmer
    "diff": [(0.0, (40, 80, 220)), (0.5, (245, 245, 245)), (1.0, (220, 40, 40))],
}

PALETTES = [name for name in _STOPS if name != "diff"]


def lut(name: str) -> np.ndarray:
    stops = _STOPS.get(name) or _STOPS["ironbow"]
    pos = np.array([p for p, _ in stops])
    cols = np.array([c for _, c in stops], dtype=np.float32)
    x = np.linspace(0, 1, 256)
    return np.stack([np.interp(x, pos, cols[:, i]) for i in range(3)], axis=1).astype(np.uint8)


def render(matrix: np.ndarray, palette: str = "ironbow", vmin: float | None = None, vmax: float | None = None,
           scale: int = 1) -> Image.Image:
    lo = float(np.nanmin(matrix)) if vmin is None else vmin
    hi = float(np.nanmax(matrix)) if vmax is None else vmax
    span = max(hi - lo, 1e-6)
    idx = np.clip((matrix - lo) / span * 255, 0, 255).astype(np.uint8)
    img = Image.fromarray(lut(palette)[idx], "RGB")
    if scale > 1:
        img = img.resize((img.width * scale, img.height * scale), Image.Resampling.BICUBIC)
    return img


def render_diff(diff: np.ndarray, limit: float | None = None, scale: int = 1) -> Image.Image:
    lim = limit if limit else max(float(np.nanmax(np.abs(diff))), 0.5)
    return render(diff, "diff", -lim, lim, scale)


def to_bytes(img: Image.Image, fmt: str = "PNG", quality: int = 92) -> bytes:
    buf = io.BytesIO()
    if fmt.upper() == "JPEG":
        img.save(buf, "JPEG", quality=quality)
    else:
        img.save(buf, fmt)
    return buf.getvalue()
