"""Snapshot library: SQLite index + radiometric JPEG files on disk."""

from __future__ import annotations

import hashlib
import json
import re
import sqlite3
import threading
import uuid
from collections import OrderedDict
from datetime import datetime
from pathlib import Path
from typing import Any

import numpy as np

from . import palettes, radiometric
from .analysis import clamp_point, frame_stats, measure_all

SCHEMA = """
CREATE TABLE IF NOT EXISTS snapshots (
    id          TEXT PRIMARY KEY,
    taken_at    TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    source      TEXT NOT NULL,          -- live | import
    source_path TEXT,
    file_hash   TEXT UNIQUE,
    title       TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    tags        TEXT NOT NULL DEFAULT '[]',
    tmin        REAL, tmax REAL, tavg REAL,
    width       INTEGER, height INTEGER,
    has_visual  INTEGER NOT NULL DEFAULT 0,
    extra       TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS points (
    snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,
    name        TEXT NOT NULL,
    kind        TEXT NOT NULL,          -- point | rect
    x INTEGER NOT NULL, y INTEGER NOT NULL, w INTEGER, h INTEGER,
    PRIMARY KEY (snapshot_id, idx)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_snapshots_taken ON snapshots(taken_at);
CREATE INDEX IF NOT EXISTS idx_points_name ON points(name);
"""

_CAMERA_NAME = re.compile(r"(\d{14})-IR\.jpe?g$", re.I)


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def normalise_points(points: list[dict], shape: tuple[int, int]) -> list[dict]:
    out = []
    for i, p in enumerate(points):
        kind = "rect" if p.get("kind") == "rect" else "point"
        q = clamp_point({**p, "kind": kind}, shape)
        item = {"name": str(p.get("name") or f"P{i + 1}")[:64], "kind": kind, "x": q["x"], "y": q["y"]}
        if kind == "rect":
            item.update(w=q["w"], h=q["h"])
        out.append(item)
    return out


class Library:
    def __init__(self, data_dir: str | Path) -> None:
        self.dir = Path(data_dir)
        self.files = self.dir / "snapshots"
        self.files.mkdir(parents=True, exist_ok=True)
        self._db = sqlite3.connect(self.dir / "openthermcam.db", check_same_thread=False)
        self._db.row_factory = sqlite3.Row
        self._db.execute("PRAGMA foreign_keys = ON")
        self._db.executescript(SCHEMA)
        self._lock = threading.RLock()
        self._cache: OrderedDict[str, np.ndarray] = OrderedDict()

    # settings ----------------------------------------------------------------
    def get_setting(self, key: str, default: Any = None) -> Any:
        with self._lock:
            row = self._db.execute("SELECT value FROM settings WHERE key=?", (key,)).fetchone()
        return json.loads(row["value"]) if row else default

    def set_setting(self, key: str, value: Any) -> None:
        with self._lock, self._db:
            self._db.execute("INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)", (key, json.dumps(value)))

    # create ------------------------------------------------------------------
    def add(self, matrix: np.ndarray, *, taken_at: datetime | None = None, source: str = "live",
            title: str = "", notes: str = "", tags: list[str] | None = None, points: list[dict] | None = None,
            source_path: str | None = None, file_hash: str | None = None, visual_jpeg: bytes | None = None,
            extra: dict | None = None, palette: str = "ironbow") -> dict:
        taken_at = taken_at or datetime.now()
        sid = uuid.uuid4().hex[:12]
        pts = normalise_points(points or [], matrix.shape)
        stats = frame_stats(matrix)
        meta = {"openthermcam": {"id": sid, "title": title, "notes": notes, "tags": tags or [], "points": pts},
                **({"source": extra} if extra else {})}
        jpeg = palettes.to_bytes(palettes.render(matrix, palette), "JPEG")
        data = radiometric.build(matrix, jpeg, taken_at, meta)
        (self.files / f"{sid}.jpg").write_bytes(data)
        if visual_jpeg:
            (self.files / f"{sid}-visual.jpg").write_bytes(visual_jpeg)
        with self._lock, self._db:
            self._db.execute(
                "INSERT INTO snapshots(id, taken_at, created_at, source, source_path, file_hash, title, notes, tags,"
                " tmin, tmax, tavg, width, height, has_visual, extra) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (sid, taken_at.isoformat(timespec="seconds"), _now(), source, source_path,
                 file_hash or hashlib.sha1(data).hexdigest(), title, notes, json.dumps(tags or []),
                 stats["min"], stats["max"], stats["avg"], matrix.shape[1], matrix.shape[0],
                 int(bool(visual_jpeg)), json.dumps(extra or {})),
            )
            self._write_points(sid, pts)
        return self.get(sid)

    def import_file(self, path: str | Path) -> tuple[dict | None, str]:
        """Import one radiometric JPEG. Returns (snapshot, status) with status imported|duplicate|skipped."""
        path = Path(path)
        data = path.read_bytes()
        if not radiometric.is_radiometric(data):
            return None, "skipped"
        digest = hashlib.sha1(data).hexdigest()
        with self._lock:
            row = self._db.execute("SELECT id FROM snapshots WHERE file_hash=?", (digest,)).fetchone()
        if row:
            return self.get(row["id"]), "duplicate"
        img = radiometric.parse(data)
        taken = None
        m = _CAMERA_NAME.search(path.name)
        if m:  # camera file names use local time; its embedded timestamp is UTC+8
            taken = datetime.strptime(m.group(1), "%Y%m%d%H%M%S")
        taken = taken or img.timestamp or datetime.fromtimestamp(path.stat().st_mtime)
        visual = None
        if m:
            sibling = path.with_name(path.name[: m.start(0)] + m.group(1) + "-DC.jpg")
            if sibling.exists():
                visual = sibling.read_bytes()
        tags = ["import", "camera" if m else "bestand"]
        snap = self.add(img.matrix, taken_at=taken, source="import", title=path.stem, tags=tags,
                        points=img.rois, source_path=str(path), file_hash=digest, visual_jpeg=visual,
                        extra={k: v for k, v in img.meta.items() if k != "roi"})
        return snap, "imported"

    def import_folder(self, folder: str | Path, recursive: bool = True) -> dict:
        folder = Path(folder)
        if not folder.is_dir():
            raise FileNotFoundError(f"folder not found: {folder}")
        result = {"imported": [], "duplicate": 0, "skipped": 0, "errors": []}
        pattern = "**/*.jpg" if recursive else "*.jpg"
        for f in sorted(folder.glob(pattern)):
            if f.name.lower().endswith("-dc.jpg") or f.parent == self.files:
                continue
            try:
                snap, status = self.import_file(f)
            except Exception as exc:  # keep going on a single bad file
                result["errors"].append(f"{f.name}: {exc}")
                continue
            if status == "imported":
                result["imported"].append(snap["id"])
            else:
                result[status] += 1
        return result

    # read --------------------------------------------------------------------
    def _row(self, row: sqlite3.Row) -> dict:
        d = dict(row)
        d["tags"] = json.loads(d["tags"])
        d["extra"] = json.loads(d["extra"])
        d["has_visual"] = bool(d["has_visual"])
        return d

    def get(self, sid: str) -> dict:
        with self._lock:
            row = self._db.execute("SELECT * FROM snapshots WHERE id=?", (sid,)).fetchone()
        if not row:
            raise KeyError(sid)
        d = self._row(row)
        d["points"] = self.points(sid)
        return d

    def list(self, q: str = "", tag: str = "", limit: int = 200, offset: int = 0, since: str = "",
             until: str = "") -> list[dict]:
        sql = "SELECT * FROM snapshots WHERE 1=1"
        args: list[Any] = []
        if q:
            sql += " AND (title LIKE ? OR notes LIKE ? OR tags LIKE ?)"
            args += [f"%{q}%"] * 3
        if tag:
            sql += " AND tags LIKE ?"
            args.append(f'%"{tag}"%')
        if since:
            sql += " AND taken_at >= ?"
            args.append(since)
        if until:
            sql += " AND taken_at <= ?"
            args.append(until)
        sql += " ORDER BY taken_at DESC LIMIT ? OFFSET ?"
        args += [limit, offset]
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        return [self._row(r) for r in rows]

    def matrix(self, sid: str) -> np.ndarray:
        with self._lock:
            if sid in self._cache:
                self._cache.move_to_end(sid)
                return self._cache[sid]
        self.get(sid)  # raises KeyError if unknown
        m = radiometric.read(self.files / f"{sid}.jpg").matrix
        with self._lock:
            self._cache[sid] = m
            while len(self._cache) > 32:
                self._cache.popitem(last=False)
        return m

    def file_path(self, sid: str, visual: bool = False) -> Path:
        return self.files / (f"{sid}-visual.jpg" if visual else f"{sid}.jpg")

    def points(self, sid: str) -> list[dict]:
        with self._lock:
            rows = self._db.execute("SELECT * FROM points WHERE snapshot_id=? ORDER BY idx", (sid,)).fetchall()
        out = []
        for r in rows:
            p = {"name": r["name"], "kind": r["kind"], "x": r["x"], "y": r["y"]}
            if r["kind"] == "rect":
                p.update(w=r["w"], h=r["h"])
            out.append(p)
        return out

    def measured_points(self, sid: str) -> list[dict]:
        return measure_all(self.matrix(sid), self.points(sid))

    # update ------------------------------------------------------------------
    def _write_points(self, sid: str, pts: list[dict]) -> None:
        self._db.execute("DELETE FROM points WHERE snapshot_id=?", (sid,))
        self._db.executemany(
            "INSERT INTO points(snapshot_id, idx, name, kind, x, y, w, h) VALUES (?,?,?,?,?,?,?,?)",
            [(sid, i, p["name"], p["kind"], p["x"], p["y"], p.get("w"), p.get("h")) for i, p in enumerate(pts)],
        )

    def set_points(self, sid: str, points: list[dict]) -> list[dict]:
        pts = normalise_points(points, self.matrix(sid).shape)
        with self._lock, self._db:
            self._write_points(sid, pts)
        return pts

    def update(self, sid: str, title: str | None = None, notes: str | None = None,
               tags: list[str] | None = None) -> dict:
        self.get(sid)
        sets, args = [], []
        for col, val in (("title", title), ("notes", notes)):
            if val is not None:
                sets.append(f"{col}=?")
                args.append(val)
        if tags is not None:
            sets.append("tags=?")
            args.append(json.dumps(sorted({t.strip() for t in tags if t.strip()})))
        if sets:
            with self._lock, self._db:
                self._db.execute(f"UPDATE snapshots SET {', '.join(sets)} WHERE id=?", (*args, sid))
        return self.get(sid)

    def delete(self, sid: str) -> None:
        self.get(sid)
        with self._lock, self._db:
            self._db.execute("DELETE FROM snapshots WHERE id=?", (sid,))
            self._cache.pop(sid, None)
        for p in (self.file_path(sid), self.file_path(sid, visual=True)):
            p.unlink(missing_ok=True)

    # analysis across snapshots -------------------------------------------------
    def tags(self) -> list[str]:
        with self._lock:
            rows = self._db.execute("SELECT tags FROM snapshots").fetchall()
        return sorted({t for r in rows for t in json.loads(r["tags"])})

    def point_names(self) -> list[str]:
        with self._lock:
            rows = self._db.execute("SELECT DISTINCT name FROM points ORDER BY name").fetchall()
        return [r["name"] for r in rows]

    def trend(self, name: str, tag: str = "", limit: int = 500) -> list[dict]:
        sql = ("SELECT s.id, s.taken_at, s.title FROM points p JOIN snapshots s ON s.id = p.snapshot_id "
               "WHERE p.name = ?")
        args: list[Any] = [name]
        if tag:
            sql += " AND s.tags LIKE ?"
            args.append(f'%"{tag}"%')
        sql += " ORDER BY s.taken_at LIMIT ?"
        args.append(limit)
        with self._lock:
            rows = self._db.execute(sql, args).fetchall()
        out = []
        for r in rows:
            m = next((p for p in self.measured_points(r["id"]) if p["name"] == name), None)
            if m:
                out.append({"snapshot_id": r["id"], "taken_at": r["taken_at"], "title": r["title"], **m})
        return out
