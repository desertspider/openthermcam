// Side-panel list of measurement points bound to a ThermalView.
import { esc, fmt, h } from "./api.js";
import { pointColor } from "./thermal.js";

export class PointList {
  constructor(view, { editable = true, onChange = () => {} } = {}) {
    this.view = view;
    this.editable = editable;
    this.onChange = onChange;
    this.el = h(`<div class="points"></div>`);
  }

  rebuild() {
    const pts = this.view.points;
    this.el.innerHTML = "";
    if (!pts.length) {
      this.el.append(h(`<p class="hint">${this.editable ? "Kies <b>Punt</b> of <b>Rechthoek</b> en klik/sleep in het beeld om een meetpunt te plaatsen." : "Geen meetpunten."}</p>`));
      return;
    }
    pts.forEach((p, i) => {
      const row = h(`<div class="point-row${i === this.view.selected ? " selected" : ""}">
          <span class="swatch" style="background:${pointColor(i)}"></span>
          <div><input value="${esc(p.name)}" ${this.editable ? "" : "readonly"} aria-label="Naam meetpunt"><div class="sub"></div></div>
          <span class="val"></span>
          ${this.editable ? '<button class="icon-btn" title="Verwijderen">✕</button>' : "<span></span>"}
        </div>`);
      row.addEventListener("click", (ev) => { if (ev.target.tagName !== "BUTTON") this.view.select(i); });
      const input = row.querySelector("input");
      input.addEventListener("change", () => {
        p.name = input.value.trim() || p.name;
        this.view.drawOverlay();
        this.onChange(this.view.points);
      });
      row.querySelector("button")?.addEventListener("click", () => {
        this.view.select(i);
        this.view.removeSelected();
      });
      this.el.append(row);
    });
    this.refresh();
  }

  highlight() {
    this.el.querySelectorAll(".point-row").forEach((row, i) => row.classList.toggle("selected", i === this.view.selected));
  }

  refresh() {
    const rows = this.el.querySelectorAll(".point-row");
    this.view.points.forEach((p, i) => {
      const row = rows[i];
      if (!row) return;
      const m = this.view.measure(p);
      row.querySelector(".val").textContent = fmt(m.value);
      row.querySelector(".sub").textContent = p.kind === "rect"
        ? `rechthoek ${p.w}×${p.h} · min ${fmt(m.min)} · max ${fmt(m.max)}`
        : `punt (${p.x}, ${p.y})`;
    });
  }
}

export function statsPanel() {
  const el = h(`<div class="stats">
      <div class="stat hot"><div class="k">Max</div><div class="v" data-k="max">–</div></div>
      <div class="stat cold"><div class="k">Min</div><div class="v" data-k="min">–</div></div>
      <div class="stat"><div class="k">Gemiddeld</div><div class="v" data-k="avg">–</div></div>
      <div class="stat"><div class="k">Midden</div><div class="v" data-k="center">–</div></div>
    </div>`);
  el.update = (stats) => {
    if (!stats) return;
    for (const k of ["max", "min", "avg", "center"]) el.querySelector(`[data-k=${k}]`).textContent = fmt(stats[k]);
  };
  return el;
}

export function viewControls(view, palettes, { video = false, onMode } = {}) {
  const names = Object.keys(palettes).filter((n) => n !== "diff");
  const el = h(`<div class="toolbar">
      ${video ? `<div class="seg" data-g="mode">
        <button data-v="radiometric" class="active" title="Eigen palet uit de temperatuurmatrix (~1×/s)">Radiometrisch</button>
        <button data-v="video" title="Vloeiend camerabeeld (30 fps, palet van de camera)">Video</button></div>` : ""}
      <select data-g="palette" aria-label="Palet">${names.map((n) => `<option>${n}</option>`).join("")}</select>
      <div class="seg" data-g="range">
        <button data-v="auto" class="active">Auto</button><button data-v="lock" title="Bereik vastzetten">Vast</button></div>
      <input type="number" step="0.5" data-g="min" aria-label="Minimum" hidden>
      <input type="number" step="0.5" data-g="max" aria-label="Maximum" hidden>
      ${view.editable ? `<div class="seg" data-g="tool">
        <button data-v="select" class="active">Selecteer</button><button data-v="point">Punt</button><button data-v="rect">Rechthoek</button></div>` : ""}
      <label class="inline"><input type="checkbox" data-g="spots" checked> heet/koud</label>
    </div>`);
  const seg = (g, fn) => el.querySelectorAll(`[data-g=${g}] button`).forEach((b) => b.addEventListener("click", () => {
    el.querySelectorAll(`[data-g=${g}] button`).forEach((x) => x.classList.toggle("active", x === b));
    fn(b.dataset.v);
  }));
  const pal = el.querySelector("[data-g=palette]");
  pal.value = localStorage.getItem("otc.palette") || "ironbow";
  view.setPalette(palettes[pal.value]);
  pal.addEventListener("change", () => {
    localStorage.setItem("otc.palette", pal.value);
    view.setPalette(palettes[pal.value]);
  });
  const lo = el.querySelector("[data-g=min]"), hi = el.querySelector("[data-g=max]");
  const applyRange = () => view.setRange({ min: Number(lo.value), max: Number(hi.value) });
  seg("range", (v) => {
    lo.hidden = hi.hidden = v === "auto";
    if (v === "auto") return view.setRange(null);
    const r = view.currentRange();
    lo.value = Math.floor(r.min);
    hi.value = Math.ceil(r.max);
    applyRange();
  });
  lo.addEventListener("input", applyRange);
  hi.addEventListener("input", applyRange);
  seg("tool", (v) => (view.tool = v));
  seg("mode", (v) => { view.setMode(v); onMode?.(v); });
  el.querySelector("[data-g=spots]").addEventListener("change", (ev) => { view.showSpots = ev.target.checked; view.drawOverlay(); });
  return el;
}
