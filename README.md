# OpenThermCam

Open viewer for USB thermal cameras that ship with **TDView**, such as the **RayThink CX200+**: a live radiometric view,
measurement points, snapshots you can keep and compare, trends over time, and an **MCP
server** so an AI assistant (Claude) can look along, measure and compare.

It runs on a **Windows PC** (Python server + browser UI) and as an **Android app** that reads
the camera directly over USB-C. The user interface is in Dutch.

## Tested hardware

| | Device | System |
|---|---|---|
| Camera | **RayThink CX200+** handheld thermal camera, 256×192 sensor, USB ID `1D6B:1110` (Linux USB gadget: UVC + mass storage + RNDIS) | – |
| PC | Windows PC | Windows 11 Pro |
| Phone | Google Pixel 8 Pro (camera on the USB-C port) | Android 17 |

Other cameras that TDView handles as "UVC handheld" and that send the same in-band temperature
frames (see [docs/PROTOCOL.md](docs/PROTOCOL.md)) will most likely work too, but have not been tested.

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

The same UI runs as an Android app (`android/`), tested on a **Pixel 8 Pro with Android 17**.
Plug the thermal camera into the phone's USB-C port (directly with a USB-C cable, or with an OTG
adapter) and use it like on the PC: live view, measurement points, snapshots, library,
compare and trends, all on the phone without a PC or internet connection.

How it works:

- The app reads the camera **directly over USB** with Android's USB host API: no root, no driver,
  no extra app. It does the same UVC negotiation as Windows and receives both the H.264 video and
  the temperature frames (Kotlin, `android/app/src/main/java/.../UvcCamera.kt`).
- The UI is the web UI from `openthermcam/web`, bundled in the APK and shown in a WebView. Instead
  of the Python server it uses an on-device backend: frames arrive over a MessagePort from the
  USB code, the snapshot library is kept on the phone (IndexedDB).
- **Share** a snapshot from its detail screen: you get the radiometric JPEG (same format as the PC
  version and TDView), for example to send it to your PC and import it there, where the MCP/AI
  tools can use it. **Import** the camera's own photos with the file picker (the camera shows up
  as USB storage).
- The app opens by itself when the camera is plugged in.
- **MCP server in the app**: let Claude on your computer read and analyse the snapshots on the
  phone over Wi-Fi (see *AI integration* below).

First use:

1. Install the APK (see *Building* below, or copy `app-debug.apk` to the phone and open it).
2. Plug in the camera and switch it on; allow *OpenThermCam* to open the USB device.
3. Allow the **camera permission**. Android 9 and later require it for USB video devices, even
   though the phone's own camera is never used.

Requirements and limits:

- Android 8.0+ with USB host support (practically every phone with USB-C).
- iPhone/iPad is not possible: iOS gives apps no access to USB video devices.
- The camera can only be used by one app at a time.
- The phone powers the camera through its USB-C port, so the phone battery drains faster.

### Building the APK

Open `android/` in Android Studio and run it, or build without Android Studio:

```bash
powershell -ExecutionPolicy Bypass -File android\build.ps1 -Install
```

`build.ps1` uses JDK 17 and the Android SDK from `C:\dev\android-tools` (or `JAVA_HOME` /
`ANDROID_HOME`) and installs on the phone connected through `adb`. The web UI is copied into the
APK at build time. Helpers for development: `android\wifi-adb.ps1` switches adb to Wi-Fi so the
phone's USB-C port is free for the camera, and `android\debug.ps1` collects logcat and a screenshot.

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

### MCP server in the Android app

The Android app has its own MCP server for the snapshots stored on the phone (no live view).
Claude on a computer in the same Wi-Fi network connects to it directly; no PC app and no firewall
change are needed.

1. In the app: **Bibliotheek → MCP → MCP-server aan**. The app shows its address, a key and
   the ready-made command.
2. On the computer (Claude Code):

   ```bash
   claude mcp add --transport http openthermcam-telefoon http://<phone-ip>:8766/mcp --header "Authorization: Bearer <key>"
   ```

   Claude Desktop cannot connect to a plain-HTTP server on the local network by itself; use the
   [mcp-remote](https://www.npmjs.com/package/mcp-remote) bridge (needs Node.js) in
   `claude_desktop_config.json` (open it via Claude Desktop → Settings → Developer → Edit Config;
   on Windows it can be in `%APPDATA%\Claude\` or `%LOCALAPPDATA%\Claude-Data\<profile>\`), add the
   entry to `mcpServers` and restart Claude Desktop:

   ```json
   {
     "mcpServers": {
       "openthermcam-telefoon": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "http://<phone-ip>:8766/mcp", "--allow-http",
                  "--transport", "http-only", "--header", "Authorization:${OTC_AUTH}"],
         "env": { "OTC_AUTH": "Bearer <key>" }
       }
     }
   }
   ```

Tools: `list_snapshots`, `get_snapshot`, `get_snapshot_image`, `get_snapshot_photo`,
`get_temperature_at`, `compare_snapshots` (with difference image), `list_point_names`, `point_trend`,
`set_snapshot_points`, `annotate_snapshot`, `get_live_measurement_points`,
`set_live_measurement_points` (the points every new snapshot in the app gets).

- Transport: MCP Streamable HTTP (JSON responses), `POST /mcp`, every request needs the key
  (`Authorization: Bearer …`); without it the app answers 401.
- The app must be open (Android pauses background apps). The server is off until you switch it on,
  and comes back by itself after an app restart.
- If the phone gets another IP address, run the command again with the new address. A fixed
  address for the phone in your router (DHCP reservation) avoids that.

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
| `openthermcam/web/` | browser UI, plain ES modules, no build step; `backend-remote.js` (PC server) or `backend-local.js` (Android) is picked automatically |
| `android/` | Android app: WebView host, USB/UVC reader, build and debug scripts |

Live stream protocol (`/ws/live`): binary messages whose first byte is the type:
`1` = H.264 Annex-B frame, `2` = temperature frame (192×256 uint16 LE, deci-kelvin).
Text messages carry camera status JSON.
