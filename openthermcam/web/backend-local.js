// Backend for the Android app: camera frames from the native USB bridge, library in IndexedDB.
import { compare, frameStats, measure, normalisePoints } from "./analysis.js";
import { canvasBlob, renderCanvas, renderDiffCanvas } from "./palettes.js";
import * as radiometric from "./radiometric.js";

const MSG_H264 = 1, MSG_TEMP = 2, ROWS = 256, COLS = 192;
const native = window.OTCNative;

// ---- IndexedDB ------------------------------------------------------------------
let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("openthermcam", 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore("snapshots", { keyPath: "id" });
      d.createObjectStore("matrices");
      d.createObjectStore("visuals");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function tx(stores, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    const result = fn(...[].concat(stores).map((s) => t.objectStore(s)));
    t.oncomplete = () => resolve(result?.result ?? result);
    t.onerror = () => reject(t.error);
  });
}
const getOne = (store, key) => tx(store, "readonly", (s) => s.get(key));
const getAll = (store) => tx(store, "readonly", (s) => s.getAll());

// ---- helpers ----------------------------------------------------------------------
const pad = (v) => String(v).padStart(2, "0");
const isoLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const newId = () => [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, "0")).join("");
async function sha1(bytes) {
  const h = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const rawToCelsius = (raw) => {
  const t = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) t[i] = raw[i] / 10 - 273.15;
  return t;
};
function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---- native bridge -------------------------------------------------------------------
const liveListeners = new Set();
let latest = null; // {data, time}
let cameraStatus = { status: native ? "connecting" : "error", message: native ? "" : "geen USB-brug (alleen in de Android-app)", temperature_frames: 0, video_frames: 0 };

function dispatch(type, payload) {
  if (type === MSG_TEMP) {
    const raw = new Uint16Array(payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength));
    latest = { data: rawToCelsius(raw), time: Date.now() };
    for (const l of liveListeners) l.onTemp(raw);
  } else if (type === MSG_H264) {
    for (const l of liveListeners) l.onVideo(payload);
  }
}

if (native) {
  window.addEventListener("message", (ev) => {
    if (ev.data !== "otc-port" || !ev.ports?.[0]) return;
    const port = ev.ports[0];
    port.onmessage = (m) => {
      const d = m.data;
      if (d instanceof ArrayBuffer) {
        const u = new Uint8Array(d);
        dispatch(u[0], u.subarray(1));
      } else if (typeof d === "string" && d.startsWith("b64:")) {
        const u = b64ToBytes(d.slice(4));
        dispatch(u[0], u.subarray(1));
      } else if (typeof d === "string") {
        try {
          cameraStatus = { ...cameraStatus, ...JSON.parse(d) };
          for (const l of liveListeners) l.onStatus?.(cameraStatus);
        } catch { /* ignore */ }
      }
    };
  });
  native.connect();
}

// ---- library ----------------------------------------------------------------------------
async function saveSnapshot(data, rows, cols, { taken = new Date(), source = "live", title = "", notes = "", tags = [], points = [], visual = null, hash = null, sourcePath = null }) {
  const id = newId();
  const stats = frameStats(data, rows, cols);
  const snap = {
    id, taken_at: isoLocal(taken), created_at: isoLocal(new Date()), source, source_path: sourcePath, file_hash: hash,
    title, notes, tags: [...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort(),
    tmin: stats.min, tmax: stats.max, tavg: stats.avg, width: cols, height: rows, has_visual: !!visual,
    points: normalisePoints(points, rows, cols),
  };
  await tx(["snapshots", "matrices", "visuals"], "readwrite", (s, m, v) => {
    s.put(snap);
    m.put({ data: data.buffer.slice(0), rows, cols }, id);
    if (visual) v.put(visual, id);
  });
  return snap;
}

async function loadMatrix(id) {
  const m = await getOne("matrices", id);
  if (!m) throw new Error(`snapshot ${id} niet gevonden`);
  return { data: new Float32Array(m.data), rows: m.rows, cols: m.cols };
}

async function getSnap(id) {
  const s = await getOne("snapshots", id);
  if (!s) throw new Error(`snapshot ${id} niet gevonden`);
  return s;
}

const urlCache = new Map();
async function cachedUrl(key, make) {
  if (!urlCache.has(key)) urlCache.set(key, make().then((b) => URL.createObjectURL(b)));
  return urlCache.get(key);
}
function dropUrls(id) {
  for (const k of urlCache.keys()) if (k.includes(id)) { urlCache.get(k).then(URL.revokeObjectURL); urlCache.delete(k); }
}

export function createLocalBackend() {
  return {
    kind: "local",
    async status() {
      const age = latest ? (Date.now() - latest.time) / 1000 : null;
      return { camera: { ...cameraStatus, has_video: true, matrix_age: age } };
    },
    async livePoints() { return JSON.parse(localStorage.getItem("otc.livePoints") || "[]"); },
    async setLivePoints(pts) {
      const n = normalisePoints(pts, ROWS, COLS);
      localStorage.setItem("otc.livePoints", JSON.stringify(n));
      return n;
    },
    async snapshot({ title = "", notes = "", tags = [], points }) {
      if (!latest || Date.now() - latest.time > 5000) throw new Error("geen actuele temperatuurdata van de camera");
      const pts = points ?? (await this.livePoints());
      const snap = await saveSnapshot(latest.data.slice(), ROWS, COLS, { title, notes, tags, points: pts });
      return { ...snap, points: snap.points.map((p) => measure(latest.data, ROWS, COLS, p)) };
    },
    async list({ q = "", tag = "", limit = 500 } = {}) {
      const ql = q.toLowerCase();
      return (await getAll("snapshots"))
        .filter((s) => !tag || s.tags.includes(tag))
        .filter((s) => !ql || [s.title, s.notes, ...s.tags].some((v) => v.toLowerCase().includes(ql)))
        .sort((a, b) => b.taken_at.localeCompare(a.taken_at))
        .slice(0, limit);
    },
    async get(id) {
      const s = await getSnap(id);
      const m = await loadMatrix(id);
      return { ...s, points: s.points.map((p) => measure(m.data, m.rows, m.cols, p)), stats: frameStats(m.data, m.rows, m.cols) };
    },
    async update(id, { title, notes, tags }) {
      const s = await getSnap(id);
      if (title !== undefined) s.title = title;
      if (notes !== undefined) s.notes = notes;
      if (tags !== undefined) s.tags = [...new Set(tags.map((t) => t.trim()).filter(Boolean))].sort();
      await tx("snapshots", "readwrite", (st) => st.put(s));
      return s;
    },
    async remove(id) {
      await tx(["snapshots", "matrices", "visuals"], "readwrite", (s, m, v) => { s.delete(id); m.delete(id); v.delete(id); });
      dropUrls(id);
      return { deleted: id };
    },
    async setPoints(id, pts) {
      const s = await getSnap(id);
      const m = await loadMatrix(id);
      s.points = normalisePoints(pts, m.rows, m.cols);
      await tx("snapshots", "readwrite", (st) => st.put(s));
      return s.points.map((p) => measure(m.data, m.rows, m.cols, p));
    },
    matrix: loadMatrix,
    async compare(a, b) {
      const [sa, sb, ma, mb] = await Promise.all([getSnap(a), getSnap(b), loadMatrix(a), loadMatrix(b)]);
      const { diff, ...r } = compare(ma.data, mb.data, ma.rows, ma.cols, sa.points, sb.points);
      return { a_id: a, b_id: b, ...r };
    },
    async tags() { return [...new Set((await getAll("snapshots")).flatMap((s) => s.tags))].sort(); },
    async pointNames() { return [...new Set((await getAll("snapshots")).flatMap((s) => s.points.map((p) => p.name)))].sort(); },
    async trend(name, tag = "") {
      const snaps = (await getAll("snapshots"))
        .filter((s) => (!tag || s.tags.includes(tag)) && s.points.some((p) => p.name === name))
        .sort((a, b) => a.taken_at.localeCompare(b.taken_at));
      const out = [];
      for (const s of snaps) {
        const m = await loadMatrix(s.id);
        const p = s.points.find((x) => x.name === name);
        out.push({ snapshot_id: s.id, taken_at: s.taken_at, title: s.title, ...measure(m.data, m.rows, m.cols, p) });
      }
      return out;
    },
    async imageUrl(id, { palette = "ironbow", vmin, vmax } = {}) {
      return cachedUrl(`${id}|${palette}|${vmin}|${vmax}`, async () => {
        const m = await loadMatrix(id);
        return canvasBlob(renderCanvas(m.data, m.rows, m.cols, palette, vmin, vmax));
      });
    },
    async compareImageUrl(a, b) {
      return cachedUrl(`cmp|${a}|${b}`, async () => {
        const [ma, mb] = await Promise.all([loadMatrix(a), loadMatrix(b)]);
        const diff = new Float32Array(ma.data.length);
        for (let i = 0; i < diff.length; i++) diff[i] = mb.data[i] - ma.data[i];
        return canvasBlob(renderDiffCanvas(diff, ma.rows, ma.cols));
      });
    },
    async visualUrl(id) {
      const blob = await getOne("visuals", id);
      return blob ? URL.createObjectURL(blob) : null;
    },
    async downloadSnapshot(id) {
      const [s, m] = await Promise.all([getSnap(id), loadMatrix(id)]);
      const jpeg = new Uint8Array(await (await canvasBlob(renderCanvas(m.data, m.rows, m.cols, "ironbow"), "image/jpeg")).arrayBuffer());
      const [y, mo, d, h, mi, se] = s.taken_at.split(/[-T:]/).map(Number);
      const meta = { openthermcam: { id, title: s.title, notes: s.notes, tags: s.tags, points: s.points } };
      const file = radiometric.build(m.data, m.rows, m.cols, jpeg, new Date(y, mo - 1, d, h, mi, se), meta);
      const name = `${(s.title || "snapshot").replace(/[^\w.-]+/g, "_")}-${id}.jpg`;
      if (native?.shareFile) native.shareFile(name, "image/jpeg", bytesToB64(file));
      else {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([file], { type: "image/jpeg" }));
        a.download = name;
        a.click();
      }
    },
    /** Import radiometric JPEGs chosen with a file picker (camera *-IR.jpg with optional *-DC.jpg, TDView snapshots). */
    async importFiles(files) {
      const list = [...files];
      const byName = new Map(list.map((f) => [f.name.toLowerCase(), f]));
      const known = new Set((await getAll("snapshots")).map((s) => s.file_hash).filter(Boolean));
      const result = { imported: [], duplicate: 0, skipped: 0, errors: [] };
      for (const f of list) {
        if (/-dc\.jpe?g$/i.test(f.name)) continue;
        try {
          const bytes = new Uint8Array(await f.arrayBuffer());
          if (!radiometric.isRadiometric(bytes)) { result.skipped++; continue; }
          const hash = await sha1(bytes);
          if (known.has(hash)) { result.duplicate++; continue; }
          const img = radiometric.parse(bytes);
          const cam = /(\d{14})-IR\.jpe?g$/i.exec(f.name);
          let taken = img.timestamp || new Date(f.lastModified);
          let visual = null;
          if (cam) {
            const t = cam[1];
            taken = new Date(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14));
            visual = byName.get(`${t}-dc.jpg`) || null;
          }
          const snap = await saveSnapshot(img.data, img.rows, img.cols, {
            taken, source: "import", title: f.name.replace(/\.jpe?g$/i, ""), tags: ["import", cam ? "camera" : "tdview"],
            points: img.rois, visual, hash, sourcePath: f.name,
          });
          known.add(hash);
          result.imported.push(snap.id);
        } catch (e) {
          result.errors.push(`${f.name}: ${e.message}`);
        }
      }
      return result;
    },
    openLive({ onTemp, onVideo, onStatus }) {
      const l = { onTemp, onVideo, onStatus };
      liveListeners.add(l);
      native?.startCamera?.();
      if (latest) onTemp(new Uint16Array(latest.data.map((v) => Math.round((v + 273.15) * 10))));
      onStatus?.(cameraStatus);
      return () => liveListeners.delete(l);
    },
  };
}
