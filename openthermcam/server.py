"""HTTP + WebSocket server: live stream, snapshot library and comparison API."""

from __future__ import annotations

import asyncio
import json
import time
from contextlib import asynccontextmanager
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from . import __version__, palettes
from .analysis import compare, frame_stats, measure, measure_all
from .camera import CameraSource
from .frames import TEMP_MARKER, TEMP_FRAME_SIZE, SampleKind
from .storage import Library, normalise_points

WEB_DIR = Path(__file__).parent / "web"
MSG_H264 = 1
MSG_TEMPERATURE = 2
FRESH_SECONDS = 1.5


class Point(BaseModel):
    name: str = ""
    kind: str = "point"
    x: int
    y: int
    w: int | None = None
    h: int | None = None


class SnapshotRequest(BaseModel):
    title: str = ""
    notes: str = ""
    tags: list[str] = Field(default_factory=list)
    points: list[Point] | None = None  # default: the current live points


class SnapshotUpdate(BaseModel):
    title: str | None = None
    notes: str | None = None
    tags: list[str] | None = None


class ImportRequest(BaseModel):
    folder: str
    recursive: bool = True


def _image(matrix: np.ndarray, palette: str, scale: int, vmin: float | None, vmax: float | None) -> Response:
    img = palettes.render(matrix, palette, vmin, vmax, max(1, min(scale, 8)))
    return Response(palettes.to_bytes(img), media_type="image/png")


def create_app(camera: CameraSource, library: Library) -> FastAPI:
    clients: set[asyncio.Queue] = set()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        loop = asyncio.get_running_loop()

        def on_sample(kind: SampleKind, sample: bytes) -> None:
            if kind is SampleKind.H264:
                msg = bytes([MSG_H264]) + sample
            elif kind is SampleKind.TEMPERATURE:
                msg = bytes([MSG_TEMPERATURE]) + sample[len(TEMP_MARKER):TEMP_FRAME_SIZE]
            else:
                return
            for q in list(clients):
                loop.call_soon_threadsafe(_offer, q, kind, msg)

        camera.add_listener(on_sample)
        camera.start()
        try:
            yield
        finally:
            camera.remove_listener(on_sample)
            await asyncio.to_thread(camera.stop)

    def _offer(q: asyncio.Queue, kind: SampleKind, msg: bytes) -> None:
        if q.full():
            if kind is SampleKind.H264:
                return  # drop video under back-pressure, never temperature frames
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
        q.put_nowait(msg)

    app = FastAPI(title="OpenThermCam", version=__version__, lifespan=lifespan)

    @app.middleware("http")
    async def no_cache_ui(request, call_next):
        response = await call_next(request)
        if request.url.path == "/" or request.url.path.startswith("/static/"):
            response.headers["Cache-Control"] = "no-cache"  # always revalidate the UI after updates
        return response

    # ---- helpers -------------------------------------------------------------
    def live_points() -> list[dict]:
        return library.get_setting("live_points", [])

    def live_matrix(fresh: bool = False) -> tuple[np.ndarray, float]:
        m, t = camera.latest_matrix()
        if fresh and (t is None or time.time() - t > FRESH_SECONDS):
            m, t = camera.wait_for_matrix(newer_than=t, timeout=4.0)
        if m is None:
            raise HTTPException(503, f"no temperature data yet (camera: {camera.state.status} {camera.state.message})")
        return m, t

    def snapshot_or_404(sid: str) -> dict:
        try:
            return library.get(sid)
        except KeyError:
            raise HTTPException(404, f"snapshot {sid} not found")

    # ---- status & live -------------------------------------------------------
    @app.get("/api/status")
    def status() -> dict:
        s = camera.state
        _, t = camera.latest_matrix()
        return {
            "version": __version__,
            "camera": {"status": s.status, "message": s.message, "has_video": camera.has_video,
                       "temperature_frames": s.temp_frames, "video_frames": s.video_frames,
                       "matrix_age": None if t is None else round(time.time() - t, 2)},
            "palettes": palettes.PALETTES,
        }

    @app.get("/api/palettes")
    def get_palettes() -> dict:
        return {name: palettes.lut(name).tolist() for name in [*palettes.PALETTES, "diff"]}

    @app.get("/api/live")
    def live(fresh: bool = False) -> dict:
        m, t = live_matrix(fresh)
        return {"time": t, "age": round(time.time() - t, 2), "stats": frame_stats(m),
                "points": measure_all(m, live_points())}

    @app.get("/api/live/image")
    def live_image(palette: str = "ironbow", scale: int = 2, vmin: float | None = None, vmax: float | None = None,
                   fresh: bool = False) -> Response:
        m, _ = live_matrix(fresh)
        return _image(m, palette, scale, vmin, vmax)

    @app.get("/api/live/temperature")
    def live_temperature(x: int, y: int) -> dict:
        m, t = live_matrix()
        return {"time": t, **measure(m, {"kind": "point", "x": x, "y": y, "name": "probe"})}

    @app.get("/api/live/points")
    def get_live_points() -> list[dict]:
        return live_points()

    @app.put("/api/live/points")
    def put_live_points(points: list[Point]) -> list[dict]:
        m, _ = camera.latest_matrix()
        shape = m.shape if m is not None else (256, 192)
        pts = normalise_points([p.model_dump() for p in points], shape)
        library.set_setting("live_points", pts)
        return pts

    @app.websocket("/ws/live")
    async def ws_live(ws: WebSocket) -> None:
        await ws.accept()
        q: asyncio.Queue = asyncio.Queue(maxsize=8)
        clients.add(q)
        try:
            m, _ = camera.latest_matrix()
            if m is not None:  # immediate first frame
                raw = np.round((m + 273.15) * 10).astype("<u2").tobytes()
                await ws.send_bytes(bytes([MSG_TEMPERATURE]) + raw)
            last_status = 0.0
            while True:
                try:
                    msg = await asyncio.wait_for(q.get(), timeout=1.0)
                    await ws.send_bytes(msg)
                except asyncio.TimeoutError:
                    pass
                if time.time() - last_status > 1.0:
                    last_status = time.time()
                    await ws.send_text(json.dumps({"type": "status", **status()["camera"]}))
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            clients.discard(q)

    # ---- snapshots ------------------------------------------------------------
    @app.post("/api/snapshots")
    async def take_snapshot(req: SnapshotRequest) -> dict:
        m, t = await asyncio.to_thread(live_matrix, True)
        pts = [p.model_dump() for p in req.points] if req.points is not None else live_points()
        snap = library.add(m.copy(), title=req.title, notes=req.notes, tags=req.tags, points=pts, source="live")
        snap["points"] = library.measured_points(snap["id"])
        return snap

    @app.get("/api/snapshots")
    def list_snapshots(q: str = "", tag: str = "", limit: int = Query(200, le=1000), offset: int = 0,
                       since: str = "", until: str = "") -> list[dict]:
        return library.list(q=q, tag=tag, limit=limit, offset=offset, since=since, until=until)

    @app.get("/api/snapshots/{sid}")
    def get_snapshot(sid: str) -> dict:
        snap = snapshot_or_404(sid)
        snap["points"] = library.measured_points(sid)
        snap["stats"] = frame_stats(library.matrix(sid))
        return snap

    @app.patch("/api/snapshots/{sid}")
    def update_snapshot(sid: str, req: SnapshotUpdate) -> dict:
        snapshot_or_404(sid)
        return library.update(sid, req.title, req.notes, req.tags)

    @app.delete("/api/snapshots/{sid}")
    def delete_snapshot(sid: str) -> dict:
        snapshot_or_404(sid)
        library.delete(sid)
        return {"deleted": sid}

    @app.put("/api/snapshots/{sid}/points")
    def set_points(sid: str, points: list[Point]) -> list[dict]:
        snapshot_or_404(sid)
        library.set_points(sid, [p.model_dump() for p in points])
        return library.measured_points(sid)

    @app.get("/api/snapshots/{sid}/temperature")
    def snapshot_temperature(sid: str, x: int, y: int) -> dict:
        snapshot_or_404(sid)
        return measure(library.matrix(sid), {"kind": "point", "x": x, "y": y, "name": "probe"})

    @app.get("/api/snapshots/{sid}/image")
    def snapshot_image(sid: str, palette: str = "ironbow", scale: int = 2, vmin: float | None = None,
                       vmax: float | None = None) -> Response:
        snapshot_or_404(sid)
        return _image(library.matrix(sid), palette, scale, vmin, vmax)

    @app.get("/api/snapshots/{sid}/matrix")
    def snapshot_matrix(sid: str) -> Response:
        """Raw float32 little-endian matrix (rows x cols in the X-Shape header)."""
        snapshot_or_404(sid)
        m = library.matrix(sid)
        return Response(np.ascontiguousarray(m, "<f4").tobytes(), media_type="application/octet-stream",
                        headers={"X-Shape": f"{m.shape[0]}x{m.shape[1]}"})

    @app.get("/api/snapshots/{sid}/file")
    def snapshot_file(sid: str, visual: bool = False) -> FileResponse:
        snap = snapshot_or_404(sid)
        if visual and not snap["has_visual"]:
            raise HTTPException(404, "no visual image for this snapshot")
        return FileResponse(library.file_path(sid, visual), media_type="image/jpeg",
                            filename=f"{sid}{'-visual' if visual else ''}.jpg")

    # ---- comparison & trends --------------------------------------------------
    @app.get("/api/compare")
    def compare_snapshots(a: str, b: str) -> dict:
        snapshot_or_404(a)
        snapshot_or_404(b)
        return {"a_id": a, "b_id": b,
                **compare(library.matrix(a), library.matrix(b), library.points(a), library.points(b))}

    @app.get("/api/compare/image")
    def compare_image(a: str, b: str, scale: int = 2, limit: float | None = None) -> Response:
        snapshot_or_404(a)
        snapshot_or_404(b)
        img = palettes.render_diff(library.matrix(b) - library.matrix(a), limit, max(1, min(scale, 8)))
        return Response(palettes.to_bytes(img), media_type="image/png")

    @app.get("/api/tags")
    def tags() -> list[str]:
        return library.tags()

    @app.get("/api/point-names")
    def point_names() -> list[str]:
        return library.point_names()

    @app.get("/api/trend")
    def trend(name: str, tag: str = "") -> list[dict]:
        return library.trend(name, tag)

    @app.post("/api/import")
    def import_folder(req: ImportRequest) -> dict:
        try:
            return library.import_folder(req.folder, req.recursive)
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc))

    # ---- web UI ---------------------------------------------------------------
    @app.get("/")
    def index() -> RedirectResponse:
        return RedirectResponse("/static/index.html")

    app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
    return app
