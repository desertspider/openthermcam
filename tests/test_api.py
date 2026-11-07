import json

import pytest
from fastapi.testclient import TestClient

from openthermcam.camera.simulator import SimulatedCamera
from openthermcam.mcp_server import build
from openthermcam.server import create_app
from openthermcam.storage import Library


@pytest.fixture
def client(tmp_path):
    cam = SimulatedCamera(interval=0.2)
    with TestClient(create_app(cam, Library(tmp_path))) as c:
        cam.wait_for_matrix(None, timeout=3)
        yield c


def test_live_and_snapshot_flow(client):
    assert client.get("/api/status").json()["camera"]["status"] == "streaming"
    pts = client.put("/api/live/points", json=[{"name": "A", "kind": "point", "x": 96, "y": 128},
                                                {"name": "Box", "kind": "rect", "x": 10, "y": 10, "w": 20, "h": 20}]).json()
    assert len(pts) == 2
    live = client.get("/api/live").json()
    assert {p["name"] for p in live["points"]} == {"A", "Box"}
    assert client.get("/api/live/image").headers["content-type"] == "image/png"

    a = client.post("/api/snapshots", json={"title": "eerste", "tags": ["test"]}).json()
    b = client.post("/api/snapshots", json={"title": "tweede"}).json()
    assert a["points"][0]["name"] == "A"
    assert client.get(f"/api/snapshots/{a['id']}").json()["stats"]["width"] == 192
    m = client.get(f"/api/snapshots/{a['id']}/matrix")
    assert m.headers["x-shape"] == "256x192" and len(m.content) == 256 * 192 * 4

    cmp_ = client.get(f"/api/compare?a={a['id']}&b={b['id']}").json()
    assert {p["name"] for p in cmp_["points"]} == {"A", "Box"}
    assert client.get(f"/api/compare/image?a={a['id']}&b={b['id']}").status_code == 200
    assert len(client.get("/api/trend?name=A").json()) == 2
    assert client.get("/api/snapshots?tag=test").json()[0]["id"] == a["id"]
    assert client.delete(f"/api/snapshots/{b['id']}").status_code == 200
    assert client.get(f"/api/snapshots/{b['id']}").status_code == 404


def test_websocket_streams_temperature(client):
    with client.websocket_connect("/ws/live") as ws:
        msg = ws.receive_bytes()
        assert msg[0] == 2 and len(msg) == 1 + 256 * 192 * 2


def test_web_ui_served(client):
    assert "OpenThermCam" in client.get("/").text
    assert client.get("/static/app.js").status_code == 200


def test_mcp_tools_against_app(client):
    import anyio

    server = build("http://testserver", client=client)

    async def run():
        tools = {t.name for t in await server.list_tools()}
        assert {"take_snapshot", "compare_snapshots", "get_live_image", "point_trend"} <= tools
        await server.call_tool("set_live_measurement_points", {"points": [{"name": "X", "kind": "point", "x": 1, "y": 2}]})
        snap = await server.call_tool("take_snapshot", {"title": "via mcp"})
        return snap

    result = anyio.run(run)
    text = json.dumps(result, default=str)
    assert "via mcp" in text
