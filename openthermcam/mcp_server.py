"""MCP server for AI assistants (Claude Desktop / Claude Code).

Runs over stdio and talks to a running ``openthermcam serve`` over HTTP, because the camera
can only be opened by one process. Start the app first, then register:

    claude mcp add openthermcam -- uv --directory <repo> run openthermcam mcp
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from mcp.server.mcpserver import Image, MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.types import ToolAnnotations

READ = ToolAnnotations(readOnlyHint=True, openWorldHint=False)
WRITE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, openWorldHint=False)

INSTRUCTIONS = """OpenThermCam gives access to a USB thermal camera (192x256 pixels, portrait) and a
library of saved radiometric snapshots. All temperatures are in degrees Celsius.
Coordinates are matrix pixels: x = column 0..191 (left to right), y = row 0..255 (top to bottom).
Measurement points have a name and kind 'point' (x, y) or 'rect' (x, y, w, h). Points with the
same name on different snapshots are compared with each other and form a trend over time.
Use get_live_image / get_snapshot_image to look at the scene before placing points; the hottest
and coldest pixel positions are in the stats (hotspot/coldspot). The camera refreshes temperature
data about once per second."""


def build(base_url: str, client: httpx.Client | None = None) -> MCPServer:
    client = client or httpx.Client(base_url=base_url, timeout=15.0)
    server = MCPServer(name="openthermcam", instructions=INSTRUCTIONS)

    def call(method: str, path: str, **kw: Any) -> Any:
        try:
            r = client.request(method, path, **kw)
        except httpx.ConnectError as exc:
            raise ToolError(f"OpenThermCam app is not running at {base_url}; start it with 'openthermcam serve'") from exc
        if r.status_code >= 400:
            try:
                detail = r.json().get("detail", r.text)
            except json.JSONDecodeError:
                detail = r.text
            raise ToolError(f"{r.status_code}: {detail}")
        return r.json() if "json" in r.headers.get("content-type", "") else r.content

    def slim(s: dict) -> dict:
        keys = ("id", "taken_at", "title", "notes", "tags", "tmin", "tmax", "tavg", "source", "has_visual")
        return {k: s[k] for k in keys if k in s}

    @server.tool(annotations=READ)
    def camera_status() -> dict:
        """Camera connection status and how fresh the live temperature data is."""
        return call("GET", "/api/status")["camera"]

    @server.tool(annotations=READ)
    def get_live_temperatures() -> dict:
        """Current whole-frame stats (min/max/avg/center, hot- and coldspot position) and the values
        of the live measurement points."""
        return call("GET", "/api/live", params={"fresh": True})

    @server.tool(annotations=READ)
    def get_live_image(palette: str = "ironbow", scale: int = 2) -> list:
        """Current thermal image (PNG) rendered with a palette (ironbow, rainbow, white-hot, black-hot, lava),
        plus its stats. Use it to see what the camera is pointed at."""
        png = call("GET", "/api/live/image", params={"palette": palette, "scale": scale, "fresh": True})
        stats = call("GET", "/api/live")["stats"]
        return [Image(data=png, format="png"), json.dumps(stats)]

    @server.tool(annotations=READ)
    def get_temperature_at(x: int, y: int, snapshot_id: str = "") -> dict:
        """Temperature of one pixel, live or in a snapshot. x = column 0..191, y = row 0..255."""
        path = f"/api/snapshots/{snapshot_id}/temperature" if snapshot_id else "/api/live/temperature"
        return call("GET", path, params={"x": x, "y": y})

    @server.tool(annotations=WRITE)
    def set_live_measurement_points(points: list[dict]) -> list[dict]:
        """Replace the live measurement points. Each item: {"name": "Groep 3", "kind": "point", "x": 80, "y": 120}
        or {"name": "Kast", "kind": "rect", "x": 20, "y": 30, "w": 40, "h": 60}. Returns the points."""
        call("PUT", "/api/live/points", json=points)
        return call("GET", "/api/live")["points"]

    @server.tool(annotations=WRITE)
    def take_snapshot(title: str = "", notes: str = "", tags: list[str] | None = None,
                      points: list[dict] | None = None) -> dict:
        """Save the current radiometric frame to the library. Uses the live measurement points unless
        `points` is given. Returns the snapshot with measured point values."""
        body = {"title": title, "notes": notes, "tags": tags or []}
        if points is not None:
            body["points"] = points
        s = call("POST", "/api/snapshots", json=body)
        return {**slim(s), "points": s["points"]}

    @server.tool(annotations=READ)
    def list_snapshots(query: str = "", tag: str = "", since: str = "", until: str = "", limit: int = 50) -> list[dict]:
        """Search the snapshot library (newest first). `query` matches title/notes/tags; `since`/`until`
        are ISO dates like 2026-11-01."""
        items = call("GET", "/api/snapshots", params={"q": query, "tag": tag, "since": since, "until": until, "limit": limit})
        return [slim(s) for s in items]

    @server.tool(annotations=READ)
    def get_snapshot(snapshot_id: str) -> dict:
        """Snapshot details: metadata, frame stats and measured values of its points."""
        s = call("GET", f"/api/snapshots/{snapshot_id}")
        return {**slim(s), "stats": s["stats"], "points": s["points"]}

    @server.tool(annotations=READ)
    def get_snapshot_image(snapshot_id: str, palette: str = "ironbow", scale: int = 2) -> Image:
        """Thermal image of a snapshot (PNG)."""
        return Image(data=call("GET", f"/api/snapshots/{snapshot_id}/image", params={"palette": palette, "scale": scale}), format="png")

    @server.tool(annotations=READ)
    def get_snapshot_photo(snapshot_id: str) -> Image:
        """The camera's visual (normal) photo for an imported snapshot, if it has one."""
        return Image(data=call("GET", f"/api/snapshots/{snapshot_id}/file", params={"visual": True}), format="jpeg")

    @server.tool(annotations=WRITE)
    def set_snapshot_points(snapshot_id: str, points: list[dict]) -> list[dict]:
        """Replace the measurement points of a snapshot (same format as set_live_measurement_points).
        Returns the measured values."""
        return call("PUT", f"/api/snapshots/{snapshot_id}/points", json=points)

    @server.tool(annotations=WRITE)
    def annotate_snapshot(snapshot_id: str, title: str | None = None, notes: str | None = None,
                          tags: list[str] | None = None) -> dict:
        """Change title, notes and/or tags of a snapshot (only the given fields)."""
        return slim(call("PATCH", f"/api/snapshots/{snapshot_id}", json={"title": title, "notes": notes, "tags": tags}))

    @server.tool(annotations=READ)
    def compare_snapshots(snapshot_a: str, snapshot_b: str, include_image: bool = True) -> list:
        """Compare B against A: frame stats of both, difference stats (B - A) and per-point deltas
        (points matched by name). Optionally includes the difference image (red = warmer in B)."""
        r = call("GET", "/api/compare", params={"a": snapshot_a, "b": snapshot_b})
        out: list = [json.dumps(r)]
        if include_image:
            out.append(Image(data=call("GET", "/api/compare/image", params={"a": snapshot_a, "b": snapshot_b}), format="png"))
        return out

    @server.tool(annotations=READ)
    def point_trend(name: str, tag: str = "") -> list[dict]:
        """Values of the measurement point `name` over all snapshots (oldest first)."""
        return call("GET", "/api/trend", params={"name": name, "tag": tag})

    @server.tool(annotations=READ)
    def list_point_names() -> list[str]:
        """All measurement point names used in the library (use with point_trend)."""
        return call("GET", "/api/point-names")

    @server.tool(annotations=WRITE)
    def import_folder(folder: str) -> dict:
        """Import radiometric JPEGs from a folder, e.g. the camera's own photos (D:\\DCIM) or other
        radiometric JPEGs. Duplicates are skipped."""
        r = call("POST", "/api/import", json={"folder": folder})
        return {"imported": len(r["imported"]), "duplicate": r["duplicate"], "skipped": r["skipped"], "errors": r["errors"]}

    return server


def run(base_url: str) -> None:
    build(base_url).run("stdio")
