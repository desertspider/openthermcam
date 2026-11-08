// Combi mode: 30 fps temperatures estimated from the camera's video.
//
// The camera sends a smooth H.264 picture (its own palette, auto range) and, about once per
// second, the exact temperature matrix. Every time a matrix arrives we pair it with the latest
// video frame and learn how video brightness maps to temperature (a 256-entry lookup table).
// Video frames in between are converted with that table, so the view, the points and the
// hot/cold spots update at 30 fps. On a real frame pair this is accurate to ~0.3 °C on average;
// the next exact matrix corrects any drift. Snapshots always store the exact matrix.

const MAX_RMS = 2.0; // °C; above this the camera's palette does not map well (e.g. rainbow)
const MAX_AGE_MS = 4000; // stop estimating when the last calibration is this old

export class HybridMapper {
  constructor(rows = 256, cols = 192) {
    this.rows = rows;
    this.cols = cols;
    this.canvas = document.createElement("canvas");
    this.canvas.width = cols;
    this.canvas.height = rows;
    this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    this.lastY = null; // luminance of the latest video frame, at matrix resolution
    this.table = null;
    this.calibratedAt = 0;
    this.rms = null;
  }

  /** Luminance (0..255) of a decoded VideoFrame, resampled to the matrix grid. */
  luminance(frame) {
    this.ctx.drawImage(frame, 0, 0, this.cols, this.rows);
    const px = this.ctx.getImageData(0, 0, this.cols, this.rows).data;
    const y = new Uint8Array(this.rows * this.cols);
    for (let i = 0, j = 0; i < y.length; i++, j += 4) {
      y[i] = (px[j] * 77 + px[j + 1] * 150 + px[j + 2] * 29) >> 8;
    }
    return y;
  }

  /** Remember the latest video frame (call for every decoded frame). Returns its luminance. */
  onVideo(frame) {
    this.lastY = this.luminance(frame);
    return this.lastY;
  }

  /** Learn brightness -> temperature from the latest video frame and an exact matrix. */
  calibrate(matrix) {
    const y = this.lastY;
    if (!y || y.length !== matrix.length) return false;
    const sum = new Float64Array(256), cnt = new Uint32Array(256);
    for (let i = 0; i < y.length; i++) { sum[y[i]] += matrix[i]; cnt[y[i]]++; }
    const table = new Float32Array(256);
    const known = [];
    for (let b = 0; b < 256; b++) if (cnt[b]) { table[b] = sum[b] / cnt[b]; known.push(b); }
    if (known.length < 8) { this.table = null; return false; } // flat picture, nothing to learn
    // fill unseen brightness levels by interpolation / nearest value at the ends
    for (let b = 0, k = 0; b < 256; b++) {
      if (cnt[b]) continue;
      while (k < known.length - 1 && known[k + 1] < b) k++;
      const lo = known[k], hi = known[Math.min(k + 1, known.length - 1)];
      if (b < known[0]) table[b] = table[known[0]];
      else if (b > known.at(-1)) table[b] = table[known.at(-1)];
      else table[b] = table[lo] + ((table[hi] - table[lo]) * (b - lo)) / Math.max(hi - lo, 1);
    }
    let se = 0;
    for (let i = 0; i < y.length; i += 3) { const e = table[y[i]] - matrix[i]; se += e * e; }
    this.rms = Math.sqrt(se / Math.ceil(y.length / 3));
    this.table = this.rms <= MAX_RMS ? table : null;
    this.calibratedAt = Date.now();
    return !!this.table;
  }

  get ready() {
    return !!this.table && Date.now() - this.calibratedAt < MAX_AGE_MS;
  }

  /** Estimated temperature matrix for the latest video frame, or null when not calibrated. */
  estimate() {
    if (!this.ready || !this.lastY) return null;
    const out = new Float32Array(this.lastY.length);
    for (let i = 0; i < out.length; i++) out[i] = this.table[this.lastY[i]];
    return out;
  }
}
