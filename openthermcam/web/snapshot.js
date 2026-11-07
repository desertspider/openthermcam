// Snapshot detail: radiometric image with editable points, metadata, visual photo.
import { api, esc, fmtDate, getPalettes, h, toast } from "./api.js";
import { PointList, statsPanel, viewControls } from "./points.js";
import { ThermalView } from "./thermal.js";

export async function snapshotView(root, id) {
  const [snap, palettes, matrix] = await Promise.all([api.get(id), getPalettes(), api.matrix(id)]);
  let dirty = false;
  const view = new ThermalView({
    onPointsChange: () => { list.rebuild(); setDirty(true); },
    onSelect: () => list.highlight(),
  });
  const list = new PointList(view, { onChange: () => setDirty(true) });
  const stats = statsPanel();

  const el = h(`<div class="layout">
      <section class="panel">
        <div class="toolbar"><a href="#/library">← Bibliotheek</a><span class="spacer"></span>
          <span class="muted">${fmtDate(snap.taken_at)} · ${esc(snap.source)}</span></div>
        <div id="stage"></div>
        ${snap.has_visual ? `<details style="margin-top:12px"><summary>Visuele foto van de camera</summary>
          <img src="/api/snapshots/${id}/file?visual=true" style="max-height:60vh;margin-top:8px;border-radius:8px" alt="Visuele foto"></details>` : ""}
      </section>
      <aside>
        <div class="panel"><h3>Gegevens</h3>
          <label class="field"><span>Titel</span><input id="title" value="${esc(snap.title)}"></label>
          <label class="field"><span>Tags (komma's)</span><input id="tags" value="${esc(snap.tags.join(", "))}"></label>
          <label class="field"><span>Notitie</span><textarea id="notes">${esc(snap.notes)}</textarea></label>
          <div class="row"><button class="primary" id="save" disabled>Opslaan</button>
            <a href="/api/snapshots/${id}/file" download><button>Download JPEG</button></a>
            <span class="spacer" style="flex:1"></span><button class="danger" id="delete">Verwijderen</button></div>
        </div>
        <div class="panel"><h3>Beeld</h3><div id="stats"></div></div>
        <div class="panel"><h3>Meetpunten</h3><div id="points"></div></div>
        <div class="panel"><h3>Vergelijken</h3>
          <div class="row"><select id="other" style="flex:1"></select><button id="cmp">Vergelijk</button></div>
          <p class="hint">Meetpunten met dezelfde naam worden met elkaar vergeleken.</p></div>
      </aside>
    </div>`);
  root.append(el);
  el.querySelector("#stage").append(viewControls(view, palettes), view.el);
  el.querySelector("#stats").append(stats);
  el.querySelector("#points").append(list.el);

  view.setMatrix(matrix.data, matrix.rows, matrix.cols);
  view.setPoints(snap.points);
  stats.update(view.stats);
  list.rebuild();

  const saveBtn = el.querySelector("#save");
  function setDirty(v) { dirty = v; saveBtn.disabled = !v; }
  for (const f of ["title", "tags", "notes"]) el.querySelector(`#${f}`).addEventListener("input", () => setDirty(true));
  saveBtn.addEventListener("click", async () => {
    try {
      await api.update(id, {
        title: el.querySelector("#title").value.trim(),
        notes: el.querySelector("#notes").value,
        tags: el.querySelector("#tags").value.split(",").map((t) => t.trim()).filter(Boolean),
      });
      await api.setPoints(id, view.points);
      setDirty(false);
      toast("Opgeslagen");
    } catch (e) { toast(`Opslaan mislukt: ${esc(e.message)}`, 5000); }
  });
  el.querySelector("#delete").addEventListener("click", async () => {
    if (!confirm("Deze snapshot definitief verwijderen?")) return;
    await api.remove(id);
    toast("Verwijderd");
    location.hash = "#/library";
  });

  const others = (await api.list({ limit: 500 })).filter((s) => s.id !== id);
  el.querySelector("#other").append(...others.map((s) => h(`<option value="${s.id}">${esc(s.title || "Zonder titel")} · ${fmtDate(s.taken_at)}</option>`)));
  el.querySelector("#cmp").addEventListener("click", () => {
    const other = el.querySelector("#other").value;
    if (other) location.hash = `#/compare/${id}/${other}`;
  });

  const beforeUnload = (ev) => { if (dirty) { ev.preventDefault(); ev.returnValue = ""; } };
  window.addEventListener("beforeunload", beforeUnload);
  return () => window.removeEventListener("beforeunload", beforeUnload);
}
