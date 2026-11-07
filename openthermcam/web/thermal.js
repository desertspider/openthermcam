// ThermalView: renders a temperature matrix (or a decoded video frame) with an editable
// overlay of measurement points/rectangles, hot/cold spot markers and a hover probe.
// All coordinates of points are in matrix pixels (cols x rows, portrait 192 x 256).

import { fmt, h } from "./api.js";

const COLORS = ["#3ccf7a", "#4ac3ff", "#ff6bd6", "#ffd84a", "#b38bff", "#ff8a5c", "#7fffd4", "#ffffff"];
export const pointColor = (i) => COLORS[i % COLORS.length];

export class ThermalView {
  constructor({ editable = true, onPointsChange = () => {}, onSelect = () => {} } = {}) {
    this.editable = editable;
    this.onPointsChange = onPointsChange;
    this.onSelect = onSelect;
    this.points = [];
    this.selected = -1;
    this.tool = "select";
    this.palette = null; // array of [r,g,b]
    this.range = null; // {min,max} or null for auto
    this.showSpots = true;
    this.mode = "radiometric"; // or "video"
    this.matrix = null; // {data, rows, cols}
    this.videoFrame = null;
    this.scale = 2;

    this.el = h(`<div class="viewer">
        <div class="stage">
          <canvas class="base"></canvas>
          <canvas class="overlay" tabindex="0"></canvas>
          <div class="probe" hidden></div>
          <div class="empty">Wachten op temperatuurdata…</div>
        </div>
        <canvas class="scale"></canvas>
        <div class="scale-labels"><span class="hi">–</span><span class="mid">–</span><span class="lo">–</span></div>
      </div>`);
    this.base = this.el.querySelector("canvas.base");
    this.overlay = this.el.querySelector("canvas.overlay");
    this.probe = this.el.querySelector(".probe");
    this.emptyEl = this.el.querySelector(".empty");
    this.scaleCanvas = this.el.querySelector("canvas.scale");
    this._bindMouse();
  }

  // ---- data ---------------------------------------------------------------
  setPalette(lut) { this.palette = lut; this.render(); }
  setRange(range) { this.range = range; this.render(); }
  setMode(mode) { this.mode = mode; this.render(); }
  setPoints(points) { this.points = points.map((p) => ({ ...p })); this.selected = -1; this.drawOverlay(); }

  setMatrix(data, rows, cols) {
    this.matrix = { data, rows, cols };
    this.emptyEl.hidden = true;
    let min = Infinity, max = -Infinity, imin = 0, imax = 0, sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      sum += v;
      if (v < min) { min = v; imin = i; }
      if (v > max) { max = v; imax = i; }
    }
    this.stats = {
      min, max, avg: sum / data.length,
      center: data[(rows >> 1) * cols + (cols >> 1)],
      hot: { x: imax % cols, y: Math.floor(imax / cols) },
      cold: { x: imin % cols, y: Math.floor(imin / cols) },
    };
    if (this.base.width !== cols * this.scale) {
      this.base.width = this.overlay.width = cols * this.scale;
      this.base.height = this.overlay.height = rows * this.scale;
    }
    this.render();
  }

  setVideoFrame(frame) {
    this.videoFrame?.close?.();
    this.videoFrame = frame;
    if (this.mode === "video") this._drawVideo();
  }

  value(x, y) {
    const m = this.matrix;
    if (!m) return NaN;
    x = Math.max(0, Math.min(m.cols - 1, Math.round(x)));
    y = Math.max(0, Math.min(m.rows - 1, Math.round(y)));
    return m.data[y * m.cols + x];
  }

  measure(p) {
    if (!this.matrix) return { ...p };
    if (p.kind !== "rect") return { ...p, value: this.value(p.x, p.y) };
    const { data, cols } = this.matrix;
    let min = Infinity, max = -Infinity, sum = 0, n = 0;
    for (let y = p.y; y < p.y + p.h; y++) for (let x = p.x; x < p.x + p.w; x++) {
      const v = data[y * cols + x];
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v; n++;
    }
    return { ...p, min, max, avg: sum / n, value: sum / n };
  }

  // ---- rendering ------------------------------------------------------------
  currentRange() {
    if (this.range) return this.range;
    return this.stats ? { min: this.stats.min, max: this.stats.max } : { min: 0, max: 1 };
  }

  render() {
    if (this.mode === "video" && this.videoFrame) this._drawVideo();
    else if (this.matrix && this.palette) this._drawMatrix();
    this._drawScale();
    this.drawOverlay();
  }

  _drawMatrix() {
    const { data, rows, cols } = this.matrix;
    const { min, max } = this.currentRange();
    const span = Math.max(max - min, 1e-6);
    const img = new ImageData(cols, rows);
    const lut = this.palette;
    for (let i = 0; i < data.length; i++) {
      const idx = Math.max(0, Math.min(255, Math.round(((data[i] - min) / span) * 255)));
      const c = lut[idx];
      img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
    }
    const tmp = this._tmp ??= document.createElement("canvas");
    tmp.width = cols; tmp.height = rows;
    tmp.getContext("2d").putImageData(img, 0, 0);
    const ctx = this.base.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(tmp, 0, 0, this.base.width, this.base.height);
  }

  _drawVideo() {
    if (!this.base.width) { this.base.width = this.overlay.width = 384; this.base.height = this.overlay.height = 512; }
    const ctx = this.base.getContext("2d");
    ctx.drawImage(this.videoFrame, 0, 0, this.base.width, this.base.height);
    this.emptyEl.hidden = true;
  }

  _drawScale() {
    const c = this.scaleCanvas;
    const labels = this.el.querySelector(".scale-labels");
    const hide = !this.palette || this.mode === "video";
    c.style.visibility = labels.style.visibility = hide ? "hidden" : "visible";
    if (hide) return;
    c.width = 1; c.height = 256;
    const ctx = c.getContext("2d");
    for (let i = 0; i < 256; i++) {
      const [r, g, b] = this.palette[255 - i];
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(0, i, 1, 1);
    }
    const { min, max } = this.currentRange();
    labels.querySelector(".hi").textContent = fmt(max);
    labels.querySelector(".mid").textContent = fmt((min + max) / 2);
    labels.querySelector(".lo").textContent = fmt(min);
  }

  drawOverlay() {
    const ctx = this.overlay.getContext("2d");
    const s = this.overlay.width / (this.matrix?.cols || 192);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.font = "600 13px Segoe UI, sans-serif";
    ctx.lineWidth = 2;
    if (this.showSpots && this.stats) {
      this._marker(ctx, this.stats.hot.x * s, this.stats.hot.y * s, "#ff4a2a", fmt(this.stats.max), "▲");
      this._marker(ctx, this.stats.cold.x * s, this.stats.cold.y * s, "#4a8cff", fmt(this.stats.min), "▼");
    }
    this.points.forEach((p, i) => {
      const m = this.measure(p);
      const color = pointColor(i);
      const sel = i === this.selected;
      if (p.kind === "rect") {
        ctx.strokeStyle = color;
        ctx.setLineDash(sel ? [] : [6, 4]);
        ctx.strokeRect(p.x * s, p.y * s, p.w * s, p.h * s);
        ctx.setLineDash([]);
        this._label(ctx, p.x * s + 4, p.y * s - 6, color, `${p.name}  ${fmt(m.avg)}`);
      } else {
        const x = (p.x + 0.5) * s, y = (p.y + 0.5) * s;
        ctx.strokeStyle = color;
        ctx.beginPath();
        ctx.moveTo(x - 9, y); ctx.lineTo(x - 3, y); ctx.moveTo(x + 3, y); ctx.lineTo(x + 9, y);
        ctx.moveTo(x, y - 9); ctx.lineTo(x, y - 3); ctx.moveTo(x, y + 3); ctx.lineTo(x, y + 9);
        ctx.stroke();
        if (sel) { ctx.beginPath(); ctx.arc(x, y, 12, 0, Math.PI * 2); ctx.stroke(); }
        this._label(ctx, x + 11, y - 8, color, `${p.name}  ${fmt(m.value)}`);
      }
    });
    if (this._draft) {
      const d = this._draft;
      ctx.strokeStyle = "#fff";
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(d.x * s, d.y * s, d.w * s, d.h * s);
      ctx.setLineDash([]);
    }
  }

  _marker(ctx, x, y, color, text, sym) {
    ctx.fillStyle = color;
    ctx.textAlign = "center";
    ctx.fillText(sym, x, y + 5);
    ctx.textAlign = "left";
    this._label(ctx, x + 9, y + 18, color, text);
  }

  _label(ctx, x, y, color, text) {
    const w = ctx.measureText(text).width;
    x = Math.min(Math.max(x, 2), this.overlay.width - w - 8);
    y = Math.min(Math.max(y, 16), this.overlay.height - 4);
    ctx.fillStyle = "rgba(0,0,0,.65)";
    ctx.fillRect(x - 3, y - 13, w + 6, 17);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  // ---- interaction -------------------------------------------------------------
  _toMatrix(ev) {
    const r = this.overlay.getBoundingClientRect();
    const cols = this.matrix?.cols || 192, rows = this.matrix?.rows || 256;
    return {
      x: Math.max(0, Math.min(cols - 1, Math.floor(((ev.clientX - r.left) / r.width) * cols))),
      y: Math.max(0, Math.min(rows - 1, Math.floor(((ev.clientY - r.top) / r.height) * rows))),
      px: ev.clientX - r.left, py: ev.clientY - r.top,
    };
  }

  _hit(pos) {
    for (let i = this.points.length - 1; i >= 0; i--) {
      const p = this.points[i];
      if (p.kind === "rect") {
        if (pos.x >= p.x - 1 && pos.x <= p.x + p.w && pos.y >= p.y - 1 && pos.y <= p.y + p.h) return i;
      } else if (Math.abs(pos.x - p.x) <= 4 && Math.abs(pos.y - p.y) <= 4) return i;
    }
    return -1;
  }

  _nextName(prefix) {
    let n = 1;
    const names = new Set(this.points.map((p) => p.name));
    while (names.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  }

  select(i) {
    this.selected = i;
    this.drawOverlay();
    this.onSelect(i);
  }

  removeSelected() {
    if (this.selected < 0) return;
    this.points.splice(this.selected, 1);
    this.select(-1);
    this.onPointsChange(this.points);
  }

  _bindMouse() {
    const o = this.overlay;
    let drag = null;
    o.addEventListener("pointerdown", (ev) => {
      const pos = this._toMatrix(ev);
      o.setPointerCapture(ev.pointerId);
      if (!this.editable) return;
      if (this.tool === "point") {
        this.points.push({ name: this._nextName("P"), kind: "point", x: pos.x, y: pos.y });
        this.select(this.points.length - 1);
        this.onPointsChange(this.points);
        return;
      }
      if (this.tool === "rect") {
        drag = { mode: "create", x0: pos.x, y0: pos.y };
        this._draft = { x: pos.x, y: pos.y, w: 1, h: 1 };
        return;
      }
      const i = this._hit(pos);
      this.select(i);
      if (i >= 0) drag = { mode: "move", i, dx: pos.x - this.points[i].x, dy: pos.y - this.points[i].y, moved: false };
    });
    o.addEventListener("pointermove", (ev) => {
      const pos = this._toMatrix(ev);
      this._showProbe(pos);
      if (!drag) return;
      const cols = this.matrix?.cols || 192, rows = this.matrix?.rows || 256;
      if (drag.mode === "create") {
        const x = Math.min(drag.x0, pos.x), y = Math.min(drag.y0, pos.y);
        this._draft = { x, y, w: Math.abs(pos.x - drag.x0) + 1, h: Math.abs(pos.y - drag.y0) + 1 };
      } else {
        const p = this.points[drag.i];
        const w = p.kind === "rect" ? p.w : 1, hh = p.kind === "rect" ? p.h : 1;
        p.x = Math.max(0, Math.min(cols - w, pos.x - drag.dx));
        p.y = Math.max(0, Math.min(rows - hh, pos.y - drag.dy));
        drag.moved = true;
      }
      this.drawOverlay();
    });
    o.addEventListener("pointerup", () => {
      if (drag?.mode === "create" && this._draft) {
        const d = this._draft;
        if (d.w >= 3 && d.h >= 3) {
          this.points.push({ name: this._nextName("R"), kind: "rect", ...d });
          this.select(this.points.length - 1);
          this.onPointsChange(this.points);
        }
        this._draft = null;
        this.drawOverlay();
      } else if (drag?.mode === "move" && drag.moved) {
        this.onPointsChange(this.points);
      }
      drag = null;
    });
    o.addEventListener("pointerleave", () => (this.probe.hidden = true));
    o.addEventListener("keydown", (ev) => {
      if ((ev.key === "Delete" || ev.key === "Backspace") && this.editable) this.removeSelected();
    });
  }

  _showProbe(pos) {
    if (!this.matrix) return;
    this.probe.hidden = false;
    this.probe.textContent = `${fmt(this.value(pos.x, pos.y))}  (${pos.x}, ${pos.y})`;
    const r = this.overlay.getBoundingClientRect();
    this.probe.style.left = `${Math.min(pos.px + 14, r.width - 140)}px`;
    this.probe.style.top = `${Math.min(pos.py + 14, r.height - 24)}px`;
  }
}
