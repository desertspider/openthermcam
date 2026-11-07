# OpenThermCam

Open viewer for USB thermal cameras that ship with **TDView**: a live radiometric view,
measurement points, snapshots you can keep and compare, trends over time, and an **MCP
server** so an AI assistant (Claude) can look along, measure and compare.

The user interface is in Dutch.

## What it does

- **Live view** in the browser
  - *Radiometric*: your own palette (ironbow, rainbow, white-hot, black-hot, lava) on the full
    192×256 temperature matrix, refreshed about once per second (the camera's rate).
  - *Video*: the camera's own 30 fps picture, decoded in the browser (WebCodecs).
  - Auto range or fixed min/max, colour scale, hot- and coldspot markers, hover probe.
- **Measurement points**: points and rectangles (min/max/average), drag to move, rename,
  Delete key to remove. Live points are remembered between sessions.
- **Snapshots**: the full temperature matrix plus points, title, notes and tags. Space bar = snapshot.
- **Library**: search, filter by tag, edit points afterwards, download the radiometric JPEG.
- **Import**: the camera's own photos (`D:\DCIM\*-IR.jpg`, including the visual `-DC.jpg`)
  and old TDView snapshots, including their measurement points. Duplicates are skipped.
- **Compare**: two snapshots side by side on the same colour range, a difference image
  (red = warmer, blue = colder) and per-point deltas. Points with the same name are matched.
- **Trends**: a named point (for example "Group 3") across all snapshots over time.
- **MCP server** with 16 tools: live temperatures and image, temperature at a pixel, set points,
  take/list/annotate snapshots, compare, trends, import.

How the camera is read is documented in [docs/PROTOCOL.md](docs/PROTOCOL.md).

## Requirements

- Windows 10/11 (camera capture uses DirectShow), Python 3.11+, [uv](https://docs.astral.sh/uv/)
- A Chromium-based browser (Chrome/Edge) for the video mode; the radiometric mode works in any modern browser.
- **Close TDView first**: the camera can only be used by one program at a time.

## Getting started

```bash
uv sync
uv run openthermcam serve --open
```

This opens http://127.0.0.1:8765. Without a camera you can try everything with a simulator:

```bash
uv run openthermcam serve --simulate --open
```

Other commands:

```bash
uv run openthermcam import D:\DCIM          # import camera photos / TDView snapshots
uv run openthermcam devices                 # list DirectShow video devices
uv run openthermcam serve --device "Name"   # if your camera has another device name
```

The library is stored in `%LOCALAPPDATA%\OpenThermCam` (SQLite database + one radiometric JPEG
per snapshot). Use `--data-dir` or `OPENTHERMCAM_DATA` to choose another place.

## Android app

The same UI also runs as an Android app (`android/`). The app reads the camera directly over
USB-C (USB host API, no root, no driver) and keeps its library on the phone (IndexedDB).
Snapshots can be shared as radiometric JPEGs and imported into the PC library.

- Requires Android 8.0+ with USB host (USB-C/OTG). iOS is not possible (no access to USB cameras).
- The app opens automatically when the camera is plugged in; allow the USB permission once.
- Build: open `android/` in Android Studio and run, or without Android Studio:
  `android\build.ps1 -Install` (JDK 17 + Android SDK in `C:\dev\android-tools`, or set `JAVA_HOME`/`ANDROID_HOME`).
  The web UI from `openthermcam/web` is copied into the APK at build time.

## AI integration (MCP)

The MCP server talks to the running app (the camera can only be opened once), so keep
`openthermcam serve` running.

Claude Code:

```bash
claude mcp add openthermcam -- uv --directory C:\dev\openthermcam run openthermcam mcp
```

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "openthermcam": {
      "command": "uv",
      "args": ["--directory", "C:\\dev\\openthermcam", "run", "openthermcam", "mcp"]
    }
  }
}
```

Example questions: "Put a measurement point on the hottest connector and take a snapshot called
'meter cabinet after repair'", "Compare the last two meter cabinet snapshots, did anything get warmer?",
"Show the trend of point Group 3 this month".

Set `OPENTHERMCAM_URL` (or `openthermcam mcp --url`) if the app runs on another port or machine.

## Development

```bash
uv run pytest
```

Layout:

| Path | Contents |
|---|---|
| `openthermcam/frames.py` | classify/decode stream samples |
| `openthermcam/camera/` | DirectShow capture (ctypes, no compiled deps) and simulator |
| `openthermcam/radiometric.py` | radiometric JPEG reader/writer |
| `openthermcam/storage.py` | SQLite library, import |
| `openthermcam/analysis.py` | point/rect measurement, stats, comparison |
| `openthermcam/server.py` | FastAPI REST + WebSocket |
| `openthermcam/mcp_server.py` | MCP tools (stdio), calls the REST API |
| `openthermcam/web/` | browser UI, plain ES modules, no build step |

Live stream protocol (`/ws/live`): binary messages whose first byte is the type:
`1` = H.264 Annex-B frame, `2` = temperature frame (192×256 uint16 LE, deci-kelvin).
Text messages carry camera status JSON.
