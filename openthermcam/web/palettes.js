// Colour palettes (mirror of openthermcam/palettes.py) and client-side rendering.

const STOPS = {
  ironbow: [[0, [0, 0, 10]], [0.15, [32, 0, 96]], [0.35, [138, 16, 140]], [0.55, [214, 64, 72]], [0.72, [247, 128, 16]], [0.88, [255, 204, 32]], [1, [255, 255, 230]]],
  rainbow: [[0, [0, 0, 128]], [0.2, [0, 64, 255]], [0.4, [0, 220, 220]], [0.6, [64, 220, 64]], [0.8, [255, 200, 0]], [1, [220, 0, 0]]],
  "white-hot": [[0, [0, 0, 0]], [1, [255, 255, 255]]],
  "black-hot": [[0, [255, 255, 255]], [1, [0, 0, 0]]],
  lava: [[0, [8, 8, 24]], [0.3, [40, 40, 120]], [0.5, [150, 40, 90]], [0.7, [240, 90, 40]], [0.9, [255, 200, 80]], [1, [255, 255, 255]]],
  diff: [[0, [40, 80, 220]], [0.5, [245, 245, 245]], [1, [220, 40, 40]]],
};

export const PALETTE_NAMES = Object.keys(STOPS).filter((n) => n !== "diff");

const cache = {};
export function lut(name) {
  if (cache[name]) return cache[name];
  const stops = STOPS[name] || STOPS.ironbow;
  const out = [];
  for (let i = 0; i < 256; i++) {
    const x = i / 255;
    let k = 0;
    while (k < stops.length - 2 && x > stops[k + 1][0]) k++;
    const [p0, c0] = stops[k], [p1, c1] = stops[k + 1];
    const t = Math.min(1, Math.max(0, (x - p0) / (p1 - p0 || 1)));
    out.push(c0.map((v, j) => Math.round(v + (c1[j] - v) * t)));
  }
  return (cache[name] = out);
}

export function allPalettes() {
  return Object.fromEntries([...PALETTE_NAMES, "diff"].map((n) => [n, lut(n)]));
}

/** Render a Float32Array matrix to a canvas (cols x rows). */
export function renderCanvas(data, rows, cols, palette = "ironbow", vmin, vmax) {
  let lo = vmin, hi = vmax;
  if (lo === undefined || hi === undefined) {
    lo = Infinity; hi = -Infinity;
    for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  }
  const span = Math.max(hi - lo, 1e-6), table = lut(palette);
  const img = new ImageData(cols, rows);
  for (let i = 0; i < data.length; i++) {
    const c = table[Math.max(0, Math.min(255, Math.round(((data[i] - lo) / span) * 255)))];
    img.data[i * 4] = c[0]; img.data[i * 4 + 1] = c[1]; img.data[i * 4 + 2] = c[2]; img.data[i * 4 + 3] = 255;
  }
  const canvas = document.createElement("canvas");
  canvas.width = cols; canvas.height = rows;
  canvas.getContext("2d").putImageData(img, 0, 0);
  return canvas;
}

export function renderDiffCanvas(diff, rows, cols, limit) {
  let lim = limit;
  if (!lim) { lim = 0.5; for (const v of diff) lim = Math.max(lim, Math.abs(v)); }
  return renderCanvas(diff, rows, cols, "diff", -lim, lim);
}

export function canvasBlob(canvas, type = "image/png", quality = 0.92) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
