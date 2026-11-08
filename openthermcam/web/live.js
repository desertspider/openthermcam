// Live view: WebSocket stream (H.264 video + radiometric frames), live points, snapshots.
import { api, esc, getPalettes, h, toast } from "./api.js";
import { PointList, statsPanel, viewControls } from "./points.js";
import { ThermalView } from "./thermal.js";

const ROWS = 256, COLS = 192;

function codecFromSps(bytes) {
  // Annex-B: find NAL type 7 (SPS) and read profile/compat/level.
  for (let i = 0; i + 7 < bytes.length; i++) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1 && (bytes[i + 3] & 0x1f) === 7) {
      const hex = (v) => v.toString(16).padStart(2, "0");
      return `avc1.${hex(bytes[i + 4])}${hex(bytes[i + 5])}${hex(bytes[i + 6])}`;
    }
  }
  return null;
}

export async function liveView(root) {
  const palettes = await getPalettes();
  let savePending;
  const view = new ThermalView({
    onPointsChange: () => {
      list.rebuild();
      clearTimeout(savePending);
      savePending = setTimeout(() => api.setLivePoints(view.points).catch((e) => toast(esc(e.message))), 400);
    },
    onSelect: () => list.highlight(),
  });
  const list = new PointList(view, { onChange: () => view.onPointsChange(view.points) });
  const stats = statsPanel();
  const hasWebCodecs = "VideoDecoder" in window;

  const layout = h(`<div class="layout">
      <section class="panel" id="stage-panel"></section>
      <aside>
        <div class="panel"><h3>Beeld</h3><div id="stats"></div><p class="hint" id="age"></p></div>
        <div class="panel"><h3>Meetpunten</h3><div id="points"></div></div>
        <div class="panel"><h3>Snapshot</h3>
          <label class="field"><span>Titel</span><input id="snap-title" placeholder="bijv. Meterkast groep 3"></label>
          <label class="field"><span>Tags (komma's)</span><input id="snap-tags" placeholder="meterkast, verwarming"></label>
          <label class="field"><span>Notitie</span><textarea id="snap-notes"></textarea></label>
          <button class="primary" id="snap-btn">📸 Snapshot maken</button>
          <p class="hint">Bewaart de volledige temperatuurmatrix met de meetpunten. Sneltoets: spatiebalk.</p>
        </div>
      </aside>
      <button class="fab" id="snap-fab" title="Snapshot maken" aria-label="Snapshot maken">📸</button>
    </div>`);
  const stagePanel = layout.querySelector("#stage-panel");
  stagePanel.append(viewControls(view, palettes, { video: hasWebCodecs }), view.el);
  layout.querySelector("#stats").append(stats);
  layout.querySelector("#points").append(list.el);
  root.append(layout);

  view.setPoints(await api.livePoints().catch(() => []));
  // live points changed elsewhere (e.g. by Claude through the app's MCP server)
  const onPointsChanged = (ev) => { view.setPoints(ev.detail); list.rebuild(); };
  window.addEventListener("otc-live-points-changed", onPointsChanged);
  list.rebuild();

  // ---- snapshot -------------------------------------------------------------
  const snapBtn = layout.querySelector("#snap-btn");
  const fab = layout.querySelector("#snap-fab");
  async function takeSnapshot() {
    if (snapBtn.disabled) return;
    snapBtn.disabled = fab.disabled = true;
    try {
      const tags = layout.querySelector("#snap-tags").value.split(",").map((t) => t.trim()).filter(Boolean);
      const snap = await api.snapshot({
        title: layout.querySelector("#snap-title").value.trim(),
        notes: layout.querySelector("#snap-notes").value.trim(),
        tags,
        points: view.points,
      });
      layout.querySelector("#snap-notes").value = "";
      toast(`Snapshot opgeslagen · max ${snap.tmax.toFixed(1)} °C · <a href="#/snapshot/${snap.id}">openen</a>`);
    } catch (e) {
      toast(`Snapshot mislukt: ${esc(e.message)}`, 5000);
    } finally {
      snapBtn.disabled = fab.disabled = false;
    }
  }
  snapBtn.addEventListener("click", takeSnapshot);
  fab.addEventListener("click", takeSnapshot);
  const onKey = (ev) => {
    if (ev.code === "Space" && !["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
      ev.preventDefault();
      takeSnapshot();
    }
  };
  document.addEventListener("keydown", onKey);

  // ---- video decoder ----------------------------------------------------------
  let decoder = null, codec = null, ts = 0;
  function decodeVideo(bytes) {
    if (!hasWebCodecs || view.mode !== "video") return;
    if (!decoder) {
      codec = codecFromSps(bytes);
      if (!codec) return;
      decoder = new VideoDecoder({
        output: (frame) => view.setVideoFrame(frame),
        error: (e) => { console.warn("video decoder", e); decoder = null; },
      });
      decoder.configure({ codec, optimizeForLatency: true });
    }
    if (decoder.decodeQueueSize > 4) return;
    decoder.decode(new EncodedVideoChunk({ type: "key", timestamp: (ts += 33333), data: bytes }));
  }

  // ---- live stream (WebSocket on PC, USB bridge on Android) -------------------------
  let lastFrame = 0;
  const closeLive = api.openLive({
    onTemp(raw) {
      const t = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) t[i] = raw[i] / 10 - 273.15;
      view.setMatrix(t, ROWS, COLS);
      stats.update(view.stats);
      list.refresh();
      lastFrame = Date.now();
    },
    onVideo: decodeVideo,
  });
  const ageTimer = setInterval(() => {
    const el = layout.querySelector("#age");
    el.textContent = lastFrame ? `Temperatuurdata ${((Date.now() - lastFrame) / 1000).toFixed(1)} s oud · ververst ±1×/s` : "";
  }, 500);

  return () => {
    window.removeEventListener("otc-live-points-changed", onPointsChanged);
    closeLive();
    clearInterval(ageTimer);
    document.removeEventListener("keydown", onKey);
    try { decoder?.close(); } catch { /* already closed */ }
  };
}
