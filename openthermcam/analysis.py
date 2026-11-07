"""Measurements on temperature matrices: points, rectangles, whole-frame stats and comparison."""

from __future__ import annotations

from typing import Any

import numpy as np


def _round(v: float) -> float:
    return round(float(v), 2)


def frame_stats(m: np.ndarray) -> dict[str, Any]:
    hi = np.unravel_index(int(np.nanargmax(m)), m.shape)
    lo = np.unravel_index(int(np.nanargmin(m)), m.shape)
    h, w = m.shape
    return {
        "min": _round(m[lo]),
        "max": _round(m[hi]),
        "avg": _round(np.nanmean(m)),
        "center": _round(m[h // 2, w // 2]),
        "hotspot": {"x": int(hi[1]), "y": int(hi[0])},
        "coldspot": {"x": int(lo[1]), "y": int(lo[0])},
        "width": int(w),
        "height": int(h),
    }


def clamp_point(p: dict, shape: tuple[int, int]) -> dict:
    h, w = shape
    p = dict(p)
    p["x"] = int(min(max(int(p.get("x", 0)), 0), w - 1))
    p["y"] = int(min(max(int(p.get("y", 0)), 0), h - 1))
    if p.get("kind") == "rect":
        p["w"] = int(min(max(int(p.get("w", 1)), 1), w - p["x"]))
        p["h"] = int(min(max(int(p.get("h", 1)), 1), h - p["y"]))
    return p


def measure(m: np.ndarray, p: dict) -> dict[str, Any]:
    """Return the point dict extended with its temperature values."""
    p = clamp_point(p, m.shape)
    out = dict(p)
    if p.get("kind") == "rect":
        region = m[p["y"] : p["y"] + p["h"], p["x"] : p["x"] + p["w"]]
        out.update(min=_round(region.min()), max=_round(region.max()), avg=_round(region.mean()))
        out["value"] = out["avg"]
    else:
        out["kind"] = "point"
        out["value"] = _round(m[p["y"], p["x"]])
    return out


def measure_all(m: np.ndarray, points: list[dict]) -> list[dict]:
    return [measure(m, p) for p in points]


def compare(a: np.ndarray, b: np.ndarray, points_a: list[dict], points_b: list[dict]) -> dict[str, Any]:
    """Compare snapshot B against A. Points are matched by name; unmatched points of A are
    also measured at the same position in B."""
    diff = b - a
    by_name_b = {p.get("name"): p for p in points_b}
    rows = []
    for pa in points_a:
        pb = by_name_b.get(pa.get("name"), pa)
        ma, mb = measure(a, pa), measure(b, pb)
        rows.append({
            "name": pa.get("name"),
            "kind": ma["kind"],
            "a": ma["value"],
            "b": mb["value"],
            "delta": _round(mb["value"] - ma["value"]),
        })
    for name, pb in by_name_b.items():
        if not any(r["name"] == name for r in rows):
            mb = measure(b, pb)
            ma = measure(a, pb)
            rows.append({"name": name, "kind": mb["kind"], "a": ma["value"], "b": mb["value"],
                         "delta": _round(mb["value"] - ma["value"])})
    return {
        "a": frame_stats(a),
        "b": frame_stats(b),
        "difference": {
            "mean": _round(np.mean(diff)),
            "max_increase": _round(np.max(diff)),
            "max_decrease": _round(np.min(diff)),
            "mean_abs": _round(np.mean(np.abs(diff))),
        },
        "points": rows,
    }
