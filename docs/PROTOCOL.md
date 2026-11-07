# Camera protocol and file formats

Found by analysing TDView, capturing the camera with Media Foundation and DirectShow, and
recording USB traffic with USBPcap while TDView took a snapshot (November 2026).

## Device

The camera is a Linux USB gadget, `VID_1D6B&PID_1110`, with three functions:

| Interface | Function | Used by OpenThermCam |
|---|---|---|
| MI_00 | RNDIS network adapter (no Windows driver bound) | no |
| MI_02 | UVC video, DirectShow name **`UVC Camera 0`** | **yes** |
| MI_04 | Mass storage (FAT32), photos in `DCIM\` | import only |

No vendor commands are needed. While streaming, TDView only sends the standard UVC
probe/commit; the serial `AA .. EB AA` commands in TDView's log fail on this model and can be ignored.

## Video stream (UVC, bulk endpoint 0x83)

- One format: **H.264, 256×342, 25–30 fps**. Every frame is SPS + PPS + IDR (Annex-B, ~11–15 kB).
  It is the camera's own palette-coloured display picture, in portrait orientation.
- **In-band temperature frames.** Roughly every 1.2 s the same stream carries a radiometric sample:
  - UVC payload of 98 316 bytes = 2-byte UVC header + **98 314-byte sample**
  - sample = 10-byte marker `FF 00 FF 00 FF 00 FF 00 FF 00` + **192 × 256 uint16 little-endian**
    (row-major, 192 columns × 256 rows, portrait, same orientation as the video)
  - **T [°C] = value / 10 − 273.15** (0.1 K resolution)
  - Checked against a TDView snapshot taken at the same moment: mean absolute difference 0.05 °C
    (TDView rounds to 0.1 °C).
- The video frame is the matrix scaled by 4/3 (192→256, 256→342), so matrix coordinates map
  directly onto the video.
- Distinguish samples by their first bytes: `00 00 00 01` = H.264, `FF 00 FF 00` = temperature.
  An occasional all-zero 256-byte sample can be ignored.

### Windows capture

- **DirectShow** (Sample Grabber accepting the native H.264 type, no decoder, `BufferCB` callback)
  delivers both kinds of samples. This is what TDView and OpenThermCam use.
- **Media Foundation** (`IMFSourceReader`, and therefore Chrome's `getUserMedia`) only delivered
  the H.264 frames in testing; the temperature samples were dropped.
- **WebUSB** cannot be used: browsers block the video (and mass-storage) interface classes.
- The camera can be opened by one program at a time. Close TDView before starting OpenThermCam.

## Radiometric JPEG (camera `DCIM\*-IR.jpg` and TDView snapshots)

After the JPEG end-of-image marker (`FF D9`) there is a trailer:

| Offset | Size | Contents |
|---|---|---|
| 0 | 2 | rows (uint16 LE) = 256 |
| 2 | 2 | columns (uint16 LE) = 192 |
| 4 | 2 | unknown (256) |
| 6 | 14 | ASCII timestamp `YYYYMMDDhhmmss` (camera files: local time + 8 h) |
| 20 | rows·cols·4 | **float32 LE temperatures in °C** |
| then | ~138 | binary block (contains e.g. "USB Series") |
| then | rest | JSON: `atmosphericTransmittance`, `distanceParam`, `roi[]` (`roiName`, `roiType` e.g. `PointShape`, `tempArea` `[x, y]`, `envParams`) |

- Camera files: the JPEG is 256×342 (the screen, including the camera's on-screen overlay); a
  `-DC.jpg` file with the same timestamp is the visual photo. The file name carries the correct local time.
- TDView files: the JPEG is 192×256.
- OpenThermCam writes the same layout (header + float32 matrix + its own JSON), so its snapshot
  files can be read by the same parser.
