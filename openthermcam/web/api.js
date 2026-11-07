// Backend selection + small UI helpers shared by all views.
// In the Android app (window.OTCNative present) everything runs on the device;
// otherwise the UI talks to the Python server.
import { createLocalBackend } from "./backend-local.js";
import { createRemoteBackend } from "./backend-remote.js";
import { allPalettes } from "./palettes.js";

export const api = window.OTCNative ? createLocalBackend() : createRemoteBackend();

export async function getPalettes() {
  return allPalettes();
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
