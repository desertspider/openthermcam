"""Command line: ``openthermcam serve | mcp | import | devices``."""

from __future__ import annotations

import argparse
import os
import sys
import webbrowser
from pathlib import Path


def default_data_dir() -> Path:
    if env := os.environ.get("OPENTHERMCAM_DATA"):
        return Path(env)
    base = os.environ.get("LOCALAPPDATA")
    return Path(base) / "OpenThermCam" if base else Path.home() / ".openthermcam"


def cmd_serve(args: argparse.Namespace) -> None:
    import uvicorn

    from .camera import create_camera
    from .server import create_app
    from .storage import Library

    library = Library(args.data_dir)
    camera = create_camera(simulate=args.simulate, device_name=args.device)
    app = create_app(camera, library)
    url = f"http://{args.host}:{args.port}/"
    print(f"OpenThermCam on {url}  (data: {args.data_dir})", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        # short graceful timeout: open live WebSockets would otherwise keep Ctrl+C waiting
        uvicorn.run(app, host=args.host, port=args.port, log_level="warning", timeout_graceful_shutdown=2)
    except KeyboardInterrupt:
        pass
    print("OpenThermCam gestopt.", flush=True)


def cmd_mcp(args: argparse.Namespace) -> None:
    from .mcp_server import run

    run(args.url)


def cmd_import(args: argparse.Namespace) -> None:
    from .storage import Library

    result = Library(args.data_dir).import_folder(args.folder)
    print(f"imported {len(result['imported'])}, duplicates {result['duplicate']}, "
          f"skipped {result['skipped']}, errors {len(result['errors'])}")
    for err in result["errors"]:
        print("  ", err)


def cmd_devices(args: argparse.Namespace) -> None:
    import ctypes

    from .camera.dshow import list_video_devices

    ctypes.windll.ole32.CoInitializeEx(None, 0)
    for name in list_video_devices():
        print(name)


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="openthermcam", description="Open thermal camera viewer")
    p.add_argument("--data-dir", type=Path, default=default_data_dir(), help="snapshot library location")
    sub = p.add_subparsers(dest="cmd", required=True)

    s = sub.add_parser("serve", help="run the camera bridge + web UI")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--device", default="UVC Camera 0", help="DirectShow device name of the camera")
    s.add_argument("--simulate", action="store_true", help="use a synthetic camera")
    s.add_argument("--open", action="store_true", help="open the browser")
    s.set_defaults(fn=cmd_serve)

    m = sub.add_parser("mcp", help="run the MCP server (stdio); talks to a running 'serve'")
    m.add_argument("--url", default=os.environ.get("OPENTHERMCAM_URL", "http://127.0.0.1:8765"))
    m.set_defaults(fn=cmd_mcp)

    i = sub.add_parser("import", help="import radiometric JPEGs (camera DCIM or TDView snapshots)")
    i.add_argument("folder", type=Path)
    i.set_defaults(fn=cmd_import)

    d = sub.add_parser("devices", help="list DirectShow video devices")
    d.set_defaults(fn=cmd_devices)

    args = p.parse_args(argv)
    args.data_dir.mkdir(parents=True, exist_ok=True)
    args.fn(args)


if __name__ == "__main__":
    sys.exit(main())
