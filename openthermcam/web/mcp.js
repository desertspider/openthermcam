// MCP tools of the Android app: read and analyse the snapshots stored on the phone.
// The HTTP/JSON-RPC part lives in Kotlin (McpServer.kt); it forwards tools/list and
// tools/call here, because the library lives in this WebView (IndexedDB).
import { api } from "./api.js";
import { onMcpRequest } from "./backend-local.js";
import { renderCanvas, renderDiffCanvas } from "./palettes.js";

const text = (obj) => ({ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 1) });

function canvasToPng(canvas, scale = 2) {
  const out = document.createElement("canvas");
  out.width = canvas.width * scale;
  out.height = canvas.height * scale;
  const ctx = out.getContext("2d");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(canvas, 0, 0, out.width, out.height);
  return { type: "image", mimeType: "image/png", data: out.toDataURL("image/png").split(",")[1] };
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const slim = (s) => ({ id: s.id, taken_at: s.taken_at, title: s.title, notes: s.notes, tags: s.tags,
  tmin: s.tmin, tmax: s.tmax, tavg: s.tavg, source: s.source, has_visual: s.has_visual });

const POINTS_SCHEMA = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" }, kind: { type: "string", enum: ["point", "rect"] },
      x: { type: "integer" }, y: { type: "integer" }, w: { type: "integer" }, h: { type: "integer" },
    },
    required: ["x", "y"],
  },
};
const ID = { snapshot_id: { type: "string", description: "Snapshot id from list_snapshots" } };
const RO = { readOnlyHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export const TOOLS = [
  {
    name: "list_snapshots", annotations: RO,
    description: "Search the thermal snapshots stored on the phone (newest first). `query` matches title, notes and tags.",
    inputSchema: { type: "object", properties: { query: { type: "string" }, tag: { type: "string" }, limit: { type: "integer", default: 50 } } },
    async run({ query = "", tag = "", limit = 50 }) {
      return [text((await api.list({ q: query, tag, limit })).map(slim))];
    },
  },
  {
    name: "get_snapshot", annotations: RO,
    description: "Snapshot details: metadata, frame stats (min/max/avg/center, hotspot and coldspot position) and the measured values of its points.",
    inputSchema: { type: "object", properties: ID, required: ["snapshot_id"] },
    async run({ snapshot_id }) {
      const s = await api.get(snapshot_id);
      return [text({ ...slim(s), stats: s.stats, points: s.points })];
    },
  },
  {
    name: "get_snapshot_image", annotations: RO,
    description: "Thermal image of a snapshot (PNG) rendered with a palette: ironbow, rainbow, white-hot, black-hot or lava.",
    inputSchema: { type: "object", properties: { ...ID, palette: { type: "string", default: "ironbow" } }, required: ["snapshot_id"] },
    async run({ snapshot_id, palette = "ironbow" }) {
      const m = await api.matrix(snapshot_id);
      return [canvasToPng(renderCanvas(m.data, m.rows, m.cols, palette))];
    },
  },
  {
    name: "get_snapshot_photo", annotations: RO,
    description: "The camera's normal (visual) photo of an imported snapshot, if it has one.",
    inputSchema: { type: "object", properties: ID, required: ["snapshot_id"] },
    async run({ snapshot_id }) {
      const url = await api.visualUrl(snapshot_id);
      if (!url) throw new Error("this snapshot has no visual photo");
      const blob = await (await fetch(url)).blob();
      return [{ type: "image", mimeType: blob.type || "image/jpeg", data: await blobToBase64(blob) }];
    },
  },
  {
    name: "get_temperature_at", annotations: RO,
    description: "Temperature of one pixel in a snapshot. x = column 0..191 (left to right), y = row 0..255 (top to bottom).",
    inputSchema: { type: "object", properties: { ...ID, x: { type: "integer" }, y: { type: "integer" } }, required: ["snapshot_id", "x", "y"] },
    async run({ snapshot_id, x, y }) {
      const m = await api.matrix(snapshot_id);
      const cx = Math.max(0, Math.min(m.cols - 1, x | 0)), cy = Math.max(0, Math.min(m.rows - 1, y | 0));
      return [text({ x: cx, y: cy, value: Math.round(m.data[cy * m.cols + cx] * 100) / 100 })];
    },
  },
  {
    name: "compare_snapshots", annotations: RO,
    description: "Compare snapshot B against A: stats of both, difference (B - A) and per-point deltas (points matched by name). Includes the difference image (red = warmer in B, blue = colder).",
    inputSchema: { type: "object", properties: { snapshot_a: { type: "string" }, snapshot_b: { type: "string" }, include_image: { type: "boolean", default: true } }, required: ["snapshot_a", "snapshot_b"] },
    async run({ snapshot_a, snapshot_b, include_image = true }) {
      const out = [text(await api.compare(snapshot_a, snapshot_b))];
      if (include_image) {
        const [a, b] = await Promise.all([api.matrix(snapshot_a), api.matrix(snapshot_b)]);
        const diff = new Float32Array(a.data.length);
        for (let i = 0; i < diff.length; i++) diff[i] = b.data[i] - a.data[i];
        out.push(canvasToPng(renderDiffCanvas(diff, a.rows, a.cols)));
      }
      return out;
    },
  },
  {
    name: "list_point_names", annotations: RO,
    description: "All measurement point names used in the snapshots (use with point_trend).",
    inputSchema: { type: "object", properties: {} },
    async run() {
      return [text(await api.pointNames())];
    },
  },
  {
    name: "point_trend", annotations: RO,
    description: "Values of the measurement point `name` over all snapshots that have it (oldest first).",
    inputSchema: { type: "object", properties: { name: { type: "string" }, tag: { type: "string" } }, required: ["name"] },
    async run({ name, tag = "" }) {
      return [text(await api.trend(name, tag))];
    },
  },
  {
    name: "set_snapshot_points", annotations: RW,
    description: 'Replace the measurement points of a snapshot, e.g. [{"name":"Groep 3","kind":"point","x":80,"y":120}] or a rectangle {"name":"Kast","kind":"rect","x":20,"y":30,"w":40,"h":60}. Returns the measured values.',
    inputSchema: { type: "object", properties: { ...ID, points: POINTS_SCHEMA }, required: ["snapshot_id", "points"] },
    async run({ snapshot_id, points }) {
      return [text(await api.setPoints(snapshot_id, points))];
    },
  },
  {
    name: "annotate_snapshot", annotations: RW,
    description: "Change the title, notes and/or tags of a snapshot (only the given fields).",
    inputSchema: { type: "object", properties: { ...ID, title: { type: "string" }, notes: { type: "string" }, tags: { type: "array", items: { type: "string" } } }, required: ["snapshot_id"] },
    async run({ snapshot_id, title, notes, tags }) {
      return [text(slim(await api.update(snapshot_id, { title, notes, tags })))];
    },
  },
];

// ---- server settings (on/off, key) --------------------------------------------------------
export const MCP_PORT = 8766;

export function mcpSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem("otc.mcp") || "{}"); } catch { /* defaults */ }
  if (!s.key) {
    s.key = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 20);
    localStorage.setItem("otc.mcp", JSON.stringify(s));
  }
  return s;
}

/** Start or stop the app's MCP server. Returns {ok, addresses, error}. */
export function setMcpEnabled(enabled) {
  const s = { ...mcpSettings(), enabled };
  localStorage.setItem("otc.mcp", JSON.stringify(s));
  if (!enabled) { window.OTCNative.mcpStop(); return { ok: true, addresses: [] }; }
  return JSON.parse(window.OTCNative.mcpStart(s.key, MCP_PORT));
}

export function mcpAddresses() {
  try { return JSON.parse(window.OTCNative.networkAddresses()); } catch { return []; }
}

export function installMcp() {
  if (mcpSettings().enabled) setMcpEnabled(true); // resume after an app restart
  onMcpRequest(async (method, params) => {
    if (method === "tools/list") {
      return { tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations })) };
    }
    if (method === "tools/call") {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw new Error(`unknown tool ${params.name}`);
      try {
        return { content: await tool.run(params.arguments || {}), isError: false };
      } catch (e) {
        return { content: [text(e.message || String(e))], isError: true };
      }
    }
    throw new Error(`unsupported method ${method}`);
  });
}
