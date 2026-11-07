// Measurements and comparison (mirror of openthermcam/analysis.py), used by the on-device backend.

const r2 = (v) => Math.round(v * 100) / 100;

export function frameStats(data, rows, cols) {
  let min = Infinity, max = -Infinity, imin = 0, imax = 0, sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    sum += v;
    if (v < min) { min = v; imin = i; }
    if (v > max) { max = v; imax = i; }
  }
  return {
    min: r2(min), max: r2(max), avg: r2(sum / data.length),
    center: r2(data[(rows >> 1) * cols + (cols >> 1)]),
    hotspot: { x: imax % cols, y: Math.floor(imax / cols) },
    coldspot: { x: imin % cols, y: Math.floor(imin / cols) },
    width: cols, height: rows,
  };
}

export function clampPoint(p, rows, cols) {
  const q = { ...p, kind: p.kind === "rect" ? "rect" : "point" };
  q.x = Math.min(Math.max(Math.round(q.x || 0), 0), cols - 1);
  q.y = Math.min(Math.max(Math.round(q.y || 0), 0), rows - 1);
  if (q.kind === "rect") {
    q.w = Math.min(Math.max(Math.round(q.w || 1), 1), cols - q.x);
    q.h = Math.min(Math.max(Math.round(q.h || 1), 1), rows - q.y);
  } else { delete q.w; delete q.h; }
  return q;
}

export function normalisePoints(points, rows, cols) {
  return points.map((p, i) => {
    const q = clampPoint(p, rows, cols);
    const out = { name: String(p.name || `P${i + 1}`).slice(0, 64), kind: q.kind, x: q.x, y: q.y };
    if (q.kind === "rect") Object.assign(out, { w: q.w, h: q.h });
    return out;
  });
}

export function measure(data, rows, cols, p) {
  const q = clampPoint(p, rows, cols);
  if (q.kind !== "rect") return { ...q, name: p.name, value: r2(data[q.y * cols + q.x]) };
  let min = Infinity, max = -Infinity, sum = 0, n = 0;
  for (let y = q.y; y < q.y + q.h; y++) for (let x = q.x; x < q.x + q.w; x++) {
    const v = data[y * cols + x];
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v; n++;
  }
  return { ...q, name: p.name, min: r2(min), max: r2(max), avg: r2(sum / n), value: r2(sum / n) };
}

export function compare(a, b, rows, cols, pointsA, pointsB) {
  const diff = new Float32Array(a.length);
  let sum = 0, sumAbs = 0, inc = -Infinity, dec = Infinity;
  for (let i = 0; i < a.length; i++) {
    const d = b[i] - a[i];
    diff[i] = d; sum += d; sumAbs += Math.abs(d);
    if (d > inc) inc = d;
    if (d < dec) dec = d;
  }
  const byNameB = new Map(pointsB.map((p) => [p.name, p]));
  const rowsOut = [];
  for (const pa of pointsA) {
    const pb = byNameB.get(pa.name) || pa;
    const ma = measure(a, rows, cols, pa), mb = measure(b, rows, cols, pb);
    rowsOut.push({ name: pa.name, kind: ma.kind, a: ma.value, b: mb.value, delta: r2(mb.value - ma.value) });
  }
  for (const [name, pb] of byNameB) {
    if (rowsOut.some((r) => r.name === name)) continue;
    const ma = measure(a, rows, cols, pb), mb = measure(b, rows, cols, pb);
    rowsOut.push({ name, kind: mb.kind, a: ma.value, b: mb.value, delta: r2(mb.value - ma.value) });
  }
  return {
    a: frameStats(a, rows, cols), b: frameStats(b, rows, cols),
    difference: { mean: r2(sum / a.length), max_increase: r2(inc), max_decrease: r2(dec), mean_abs: r2(sumAbs / a.length) },
    points: rowsOut, diff,
  };
}
