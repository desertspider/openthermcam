// Thin wrappers around the OpenThermCam REST API.

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* not json */ }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : res;
}

export const api = {
  status: () => request("GET", "/api/status"),
  palettes: () => request("GET", "/api/palettes"),
  livePoints: () => request("GET", "/api/live/points"),
  setLivePoints: (pts) => request("PUT", "/api/live/points", pts),
  snapshot: (body) => request("POST", "/api/snapshots", body),
  list: (params = {}) => request("GET", "/api/snapshots?" + new URLSearchParams(params)),
  get: (id) => request("GET", `/api/snapshots/${id}`),
  update: (id, body) => request("PATCH", `/api/snapshots/${id}`, body),
  remove: (id) => request("DELETE", `/api/snapshots/${id}`),
  setPoints: (id, pts) => request("PUT", `/api/snapshots/${id}/points`, pts),
  compare: (a, b) => request("GET", `/api/compare?a=${a}&b=${b}`),
  tags: () => request("GET", "/api/tags"),
  pointNames: () => request("GET", "/api/point-names"),
  trend: (name, tag = "") => request("GET", "/api/trend?" + new URLSearchParams({ name, tag })),
  importFolder: (folder) => request("POST", "/api/import", { folder }),
  async matrix(id) {
    const res = await request("GET", `/api/snapshots/${id}/matrix`);
    const [rows, cols] = res.headers.get("X-Shape").split("x").map(Number);
    return { data: new Float32Array(await res.arrayBuffer()), rows, cols };
  },
  imageUrl: (id, palette = "ironbow", scale = 1) => `/api/snapshots/${id}/image?palette=${palette}&scale=${scale}`,
};

let paletteCache;
export async function getPalettes() {
  paletteCache ??= api.palettes();
  return paletteCache;
}

export function toast(msg, ms = 2800) {
  const el = document.getElementById("toast");
  el.innerHTML = msg;
  el.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.hidden = true), ms);
}

export const fmt = (v, d = 1) => (v === null || v === undefined || Number.isNaN(v) ? "–" : `${Number(v).toFixed(d)} °C`);
export const fmtDate = (iso) => new Date(iso).toLocaleString("nl-NL", { dateStyle: "short", timeStyle: "short" });

export function h(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
