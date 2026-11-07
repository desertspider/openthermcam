// Library: browse, filter, import and pick two snapshots to compare.
import { api, esc, fmtDate, h, toast } from "./api.js";

export async function libraryView(root) {
  const picked = new Set(JSON.parse(sessionStorage.getItem("otc.picked") || "[]"));
  const el = h(`<div>
      <div class="toolbar">
        <input id="q" placeholder="Zoeken in titel, notities, tags…" style="min-width:260px">
        <select id="tag"><option value="">Alle tags</option></select>
        <span class="spacer"></span>
        <button id="compare" disabled>Vergelijk geselecteerde (0/2)</button>
        ${api.kind === "local"
          ? `<label class="button-like"><input type="file" id="files" accept="image/jpeg,.jpg" multiple hidden>Foto's importeren…</label>`
          : `<input id="folder" placeholder="Map met radiometrische JPEG's" value="${esc(localStorage.getItem("otc.importDir") || "D:\\DCIM")}" style="width:220px">
             <button id="import">Importeren</button>`}
      </div>
      <div class="grid" id="grid"></div>
      <p class="hint" id="count"></p>
    </div>`);
  root.append(el);
  const grid = el.querySelector("#grid");
  const compareBtn = el.querySelector("#compare");

  const tags = await api.tags();
  el.querySelector("#tag").append(...tags.map((t) => h(`<option>${esc(t)}</option>`)));

  function updatePicked() {
    sessionStorage.setItem("otc.picked", JSON.stringify([...picked]));
    compareBtn.disabled = picked.size !== 2;
    compareBtn.textContent = `Vergelijk geselecteerde (${picked.size}/2)`;
  }

  async function load() {
    const items = await api.list({ q: el.querySelector("#q").value, tag: el.querySelector("#tag").value, limit: 500 });
    grid.innerHTML = "";
    el.querySelector("#count").textContent = `${items.length} snapshot(s)`;
    if (!items.length) grid.append(h(`<p class="muted">Nog geen snapshots. Maak er een in <a href="#/live">Live</a> of importeer de foto's van de camera.</p>`));
    for (const s of items) {
      const card = h(`<div class="card${picked.has(s.id) ? " picked" : ""}">
          <input type="checkbox" class="pick" title="Selecteren om te vergelijken" ${picked.has(s.id) ? "checked" : ""}>
          <img loading="lazy" alt="">
          <div class="meta">
            <div class="title">${esc(s.title || "Zonder titel")}</div>
            <div class="sub"><span>${fmtDate(s.taken_at)}</span><span>${s.tmax.toFixed(1)} °C</span></div>
            <div class="tags">${s.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join("")}</div>
          </div>
        </div>`);
      api.imageUrl(s.id, { palette: localStorage.getItem("otc.palette") || "ironbow" }).then((url) => (card.querySelector("img").src = url));
      const box = card.querySelector(".pick");
      box.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (box.checked) {
          if (picked.size >= 2) picked.delete([...picked][0]);
          picked.add(s.id);
        } else picked.delete(s.id);
        updatePicked();
        load();
      });
      card.addEventListener("click", () => (location.hash = `#/snapshot/${s.id}`));
      grid.append(card);
    }
  }

  let t;
  el.querySelector("#q").addEventListener("input", () => { clearTimeout(t); t = setTimeout(load, 250); });
  el.querySelector("#tag").addEventListener("change", load);
  compareBtn.addEventListener("click", () => {
    const [a, b] = [...picked];
    location.hash = `#/compare/${a}/${b}`;
  });
  async function runImport(task, control) {
    control.disabled = true;
    try {
      const r = await task();
      toast(`${r.imported.length} geïmporteerd · ${r.duplicate} al aanwezig · ${r.skipped} overgeslagen${r.errors.length ? ` · ${r.errors.length} fouten` : ""}`, 5000);
      load();
    } catch (e) {
      toast(`Import mislukt: ${esc(e.message)}`, 5000);
    } finally {
      control.disabled = false;
    }
  }
  el.querySelector("#import")?.addEventListener("click", (ev) => {
    const folder = el.querySelector("#folder").value.trim();
    localStorage.setItem("otc.importDir", folder);
    runImport(() => api.importFolder(folder), ev.target);
  });
  const files = el.querySelector("#files");
  files?.addEventListener("change", () => runImport(() => api.importFiles(files.files), files));
  updatePicked();
  await load();
}
