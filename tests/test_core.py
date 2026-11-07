from datetime import datetime

import numpy as np
import pytest

from openthermcam import HEIGHT, WIDTH, frames, radiometric
from openthermcam.analysis import compare, frame_stats, measure
from openthermcam.camera.simulator import synthetic_matrix
from openthermcam.storage import Library


def test_temperature_frame_roundtrip():
    m = synthetic_matrix(1.0)
    sample = frames.encode_temperature(m)
    assert len(sample) == frames.TEMP_FRAME_SIZE == 98314
    assert frames.classify(sample) is frames.SampleKind.TEMPERATURE
    back = frames.decode_temperature(sample)
    assert back.shape == (HEIGHT, WIDTH)
    assert np.max(np.abs(back - m)) <= 0.051


def test_known_raw_value():
    # 0x0B6D = 2925 deci-kelvin = 19.35 degC (seen in the real USB capture)
    raw = np.full((HEIGHT, WIDTH), 2925, dtype="<u2")
    t = frames.decode_temperature(frames.TEMP_MARKER + raw.tobytes())
    assert t[0, 0] == pytest.approx(19.35, abs=1e-3)


def test_classify_other_samples():
    assert frames.classify(b"\x00\x00\x00\x01\x67\x64\x00\x0d") is frames.SampleKind.H264
    assert frames.classify(bytes(256)) is frames.SampleKind.EMPTY
    assert frames.classify(b"\x12\x34" * 10) is frames.SampleKind.UNKNOWN


def test_radiometric_roundtrip_and_tdview_rois():
    m = synthetic_matrix(2.0)
    meta = {"roi": [{"roiName": "P1", "roiType": "PointShape", "tempArea": [84, 150]},
                    {"roiName": "R1", "tempArea": [10, 20, 30, 50]}]}
    data = radiometric.build(m, b"\xff\xd8fakejpeg\xff\xd9", datetime(2026, 11, 7, 20, 59, 51), meta)
    img = radiometric.parse(data)
    assert img.matrix.shape == (HEIGHT, WIDTH)
    assert np.array_equal(img.matrix, m)
    assert img.timestamp == datetime(2026, 11, 7, 20, 59, 51)
    assert img.rois == [
        {"name": "P1", "kind": "point", "x": 84, "y": 150},
        {"name": "R1", "kind": "rect", "x": 10, "y": 20, "w": 21, "h": 31},
    ]


def test_not_radiometric():
    assert not radiometric.is_radiometric(b"\xff\xd8\xff\xd9")


def test_measure_and_compare():
    a = np.full((HEIGHT, WIDTH), 20.0, np.float32)
    b = a.copy()
    b[100:110, 50:60] = 30.0
    assert measure(b, {"kind": "point", "x": 55, "y": 105})["value"] == 30.0
    rect = measure(b, {"kind": "rect", "x": 50, "y": 100, "w": 20, "h": 10})
    assert rect["max"] == 30.0 and rect["min"] == 20.0 and rect["avg"] == 25.0
    s = frame_stats(b)
    assert s["max"] == 30.0 and s["hotspot"] == {"x": 50, "y": 100}
    r = compare(a, b, [{"name": "spot", "kind": "point", "x": 55, "y": 105}], [])
    assert r["points"][0]["delta"] == 10.0
    assert r["difference"]["max_increase"] == 10.0


def test_library(tmp_path):
    lib = Library(tmp_path)
    m = synthetic_matrix(3.0)
    snap = lib.add(m, title="kast", tags=["meterkast"], points=[{"name": "G3", "kind": "point", "x": 500, "y": 10}])
    assert snap["points"][0]["x"] == WIDTH - 1  # clamped into the frame
    assert lib.list(tag="meterkast")[0]["id"] == snap["id"]
    assert np.array_equal(lib.matrix(snap["id"]), m)
    lib.update(snap["id"], notes="na reparatie", tags=["meterkast", "na"])
    assert lib.get(snap["id"])["tags"] == ["meterkast", "na"]
    snap2 = lib.add(m + 2, points=[{"name": "G3", "kind": "point", "x": 10, "y": 10}])
    trend = lib.trend("G3")
    assert [t["snapshot_id"] for t in trend] == [snap["id"], snap2["id"]]
    lib.delete(snap["id"])
    assert len(lib.list()) == 1


def test_import_camera_file_with_visual(tmp_path):
    cam = tmp_path / "DCIM"
    cam.mkdir()
    m = synthetic_matrix(4.0)
    meta = {"roi": [{"roiName": "P1", "tempArea": [5, 6]}], "emissivity": 0.95}
    (cam / "20261107171024-IR.jpg").write_bytes(radiometric.build(m, b"\xff\xd8x\xff\xd9", datetime(2026, 11, 8, 1, 10, 24), meta))
    (cam / "20261107171024-DC.jpg").write_bytes(b"\xff\xd8visual\xff\xd9")
    lib = Library(tmp_path / "lib")
    r = lib.import_folder(cam)
    assert len(r["imported"]) == 1 and r["skipped"] == 0
    snap = lib.get(r["imported"][0])
    assert snap["taken_at"] == "2026-11-07T17:10:24"  # file name (local time), not the UTC+8 header
    assert snap["has_visual"] and snap["points"] == [{"name": "P1", "kind": "point", "x": 5, "y": 6}]
    assert lib.import_folder(cam)["duplicate"] == 1
