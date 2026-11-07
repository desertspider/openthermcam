// Radiometric JPEG read/write in the browser (mirror of openthermcam/radiometric.py; see docs/PROTOCOL.md).

const HEADER = 20;

function findTrailer(bytes) {
  for (let i = 0; i + 1 < bytes.length; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xd9) continue;
    const start = i + 2;
    if (bytes.length < start + HEADER) continue;
    const dv = new DataView(bytes.buffer, bytes.byteOffset + start, 4);
    const rows = dv.getUint16(0, true), cols = dv.getUint16(2, true);
    if (rows >= 16 && rows <= 2048 && cols >= 16 && cols <= 2048 && bytes.length >= start + HEADER + rows * cols * 4) return start;
  }
  return -1;
}

export function isRadiometric(bytes) {
  return findTrailer(bytes) >= 0;
}

/** Parse an ArrayBuffer/Uint8Array. Returns {data, rows, cols, timestamp: Date|null, meta, rois, jpeg}. */
export function parse(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const start = findTrailer(bytes);
  if (start < 0) throw new Error("geen radiometrische data in dit bestand");
  const dv = new DataView(bytes.buffer, bytes.byteOffset + start);
  const rows = dv.getUint16(0, true), cols = dv.getUint16(2, true);
  const ts = new TextDecoder().decode(bytes.subarray(start + 6, start + 20));
  let timestamp = null;
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(ts);
  if (m) timestamp = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const n = rows * cols;
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = dv.getFloat32(HEADER + i * 4, true);
  let meta = {};
  const rest = bytes.subarray(start + HEADER + n * 4);
  const brace = rest.indexOf(0x7b);
  if (brace >= 0) {
    let end = rest.indexOf(0, brace);
    if (end < 0) end = rest.length;
    try { meta = JSON.parse(new TextDecoder().decode(rest.subarray(brace, end))); } catch { meta = {}; }
  }
  return { data, rows, cols, timestamp, meta, rois: roisFromMeta(meta), jpeg: bytes.subarray(0, start) };
}

function roisFromMeta(meta) {
  if (meta?.openthermcam?.points) return meta.openthermcam.points;
  const out = [];
  for (const roi of meta?.roi || []) {
    const a = roi.tempArea || [];
    const name = String(roi.roiName || `P${out.length + 1}`);
    if (a.length === 2) out.push({ name, kind: "point", x: a[0] | 0, y: a[1] | 0 });
    else if (a.length === 4) out.push({ name, kind: "rect", x: Math.min(a[0], a[2]), y: Math.min(a[1], a[3]), w: Math.abs(a[2] - a[0]) + 1, h: Math.abs(a[3] - a[1]) + 1 });
  }
  return out;
}

const pad = (v) => String(v).padStart(2, "0");
export function stamp(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Build a radiometric JPEG: jpegBytes (Uint8Array) + trailer. Returns Uint8Array. */
export function build(data, rows, cols, jpegBytes, date, meta) {
  const json = new TextEncoder().encode(JSON.stringify(meta, null, 1));
  const out = new Uint8Array(jpegBytes.length + HEADER + rows * cols * 4 + json.length);
  out.set(jpegBytes, 0);
  const dv = new DataView(out.buffer, jpegBytes.length);
  dv.setUint16(0, rows, true);
  dv.setUint16(2, cols, true);
  dv.setUint16(4, 256, true);
  out.set(new TextEncoder().encode(stamp(date)), jpegBytes.length + 6);
  for (let i = 0; i < data.length; i++) dv.setFloat32(HEADER + i * 4, data[i], true);
  out.set(json, jpegBytes.length + HEADER + rows * cols * 4);
  return out;
}
