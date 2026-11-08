// Library: browse, filter, import and pick two snapshots to compare.
import { api, esc, fmtDate, h, toast } from "./api.js";

async function setupMcpPanel(el) {
  const { MCP_PORT, mcpAddresses, mcpSettings, setMcpEnabled } = await import("./mcp.js");
  const panel = el.querySelector("#mcp-panel");
  const box = el.querySelector("#mcp-on");
  const info = el.querySelector("#mcp-info");
  el.querySelector("#mcp-toggle").addEventListener("click", () => (panel.hidden = !panel.hidden));
  const show = (error) => {
    const s = mcpSettings();
    box.checked = !!s.enabled;
    if (error) { info.innerHTML = `<p class="hint" style="color:var(--err)">${esc(error)}</p>`; return; }
    if (!s.enabled) { info.innerHTML = ""; return; }
    const ip = mcpAddresses()[0];
    if (!ip) { info.innerHTML = `<p class="hint" style="color:var(--warn)">Geen wifi-verbinding gevonden.</p>`; return; }
    const url = `http://${ip}:${MCP_PORT}/mcp`;
    const cmd = `claude mcp add --transport http openthermcam-telefoon ${url} --header "Authorization: Bearer ${s.key}"`;
    info.innerHTML = `
      <label class="field"><span>Adres</span><input readonly value="${esc(url)}"></label>
      <label class="field"><span>Sleutel</span><input readonly value="${esc(s.key)}"></label>
      <label class="field"><span>Commando voor Claude Code (op de computer)</span><textarea readonly rows="4">${esc(cmd)}</textarea></label>
      <button id="mcp-copy">Commando kopiëren</button>
      <p class="hint">Verandert het IP-adres van de telefoon (na herstart of ander wifi), voer het commando dan opnieuw uit
        met het nieuwe adres. Tip: geef de telefoon in je router een vast IP-adres.</p>`;
    info.querySelector("#mcp-copy").addEventListener("click", () =>
      navigator.clipboard.writeText(cmd).then(() => toast("Commando gekopieerd"), () => toast("Kopiëren lukte niet; selecteer de tekst")));
  };
  box.addEventListener("change", () => {
    const r = setMcpEnabled(box.checked);
    show(r.ok ? null : `Starten mislukt: ${r.error}`);
  });
  show();
}

export async function libraryView(root) {
  const picked = new Set(JSON.parse(sessionStorage.getItem("otc.picked") || "[]"));
  const el = h(`<div>
      <div class="toolbar">
        <input id="q" placeholder="Zoeken in titel, notities, tags…" style="min-width:260px">
        <select id="tag"><option value="">Alle tags</option></select>
        <span class="spacer"></span>
        <button id="compare" disabled>Vergelijk geselecteerde (0/2)</button>
        ${api.kind === "local"
          ? `<label class="button-like"><input type="file" id="files" accept="image/jpeg,.jpg" multiple hidden>Foto's importeren…</label>
             <button id="mcp-toggle" title="Claude laten meelezen via MCP">🤖 Claude</button>`
          : `<input id="folder" placeholder="Map met radiometrische JPEG's" value="${esc(localStorage.getItem("otc.importDir") || "D:\\DCIM")}" style="width:220px">
             <button id="import">Importeren</button>`}
      </div>
      ${api.kind === "local" ? `<div class="panel" id="mcp-panel" hidden style="margin-bottom:12px"><h3>Claude (MCP)</h3>
        <p class="hint" style="margin:0 0 10px">Laat Claude op je computer de snapshots op deze telefoon lezen en analyseren.
          Telefoon en computer moeten op hetzelfde wifi-netwerk zitten, en de app moet open staan.</p>
        <label class="inline" style="margin-bottom:10px"><input type="checkbox" id="mcp-on"> MCP-server aan</label>
        <div id="mcp-info"></div>
      </div>` : ""}
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
  if (api.kind === "local") await setupMcpPanel(el);
  updatePicked();
  await load();
}
