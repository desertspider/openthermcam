// Compare two snapshots side by side with a difference image and point deltas.
import { api, esc, fmt, fmtDate, h } from "./api.js";

export async function compareView(root, a, b) {
  const all = await api.list({ limit: 500 });
  // ignore ids that are missing, stale or literally "undefined"
  const known = new Set(all.map((s) => s.id));
  a = known.has(a) ? a : "";
  b = known.has(b) ? b : "";
  const opt = (sel) => `<option value="" ${sel ? "" : "selected"}>— kies een snapshot —</option>` +
    all.map((s) => `<option value="${s.id}" ${s.id === sel ? "selected" : ""}>${esc(s.title || "Zonder titel")} · ${fmtDate(s.taken_at)}</option>`).join("");
  const el = h(`<div>
      <div class="toolbar">
        <label class="inline">A <select id="a">${opt(a)}</select></label>
        <button id="swap" title="Wissel A en B">⇄</button>
        <label class="inline">B <select id="b">${opt(b)}</select></label>
      </div>
      <div id="out"></div>
    </div>`);
  root.append(el);
  const sel = (id) => el.querySelector(id).value;
  const go = (x, y) => (location.hash = `#/compare/${x || "-"}/${y || "-"}`);
  el.querySelector("#a").addEventListener("change", () => go(sel("#a"), sel("#b")));
  el.querySelector("#b").addEventListener("change", () => go(sel("#a"), sel("#b")));
  el.querySelector("#swap").addEventListener("click", () => go(sel("#b"), sel("#a")));

  const out = el.querySelector("#out");
  if (all.length < 2) {
    out.append(h(`<p class="muted">Je hebt minstens twee snapshots nodig om te vergelijken.</p>`));
    return;
  }
  if (!a || !b) {
    out.append(h(`<p class="muted">Kies hierboven twee snapshots, of selecteer er twee in de <a href="#/library">bibliotheek</a>.</p>`));
    return;
  }
  if (a === b) {
    out.append(h(`<p class="muted">Kies twee verschillende snapshots.</p>`));
    return;
  }
  const [r, sa, sb] = await Promise.all([api.compare(a, b), api.get(a), api.get(b)]);
  const palette = localStorage.getItem("otc.palette") || "ironbow";
  // render A and B on a shared temperature range so colours are comparable
  const vmin = Math.min(r.a.min, r.b.min), vmax = Math.max(r.a.max, r.b.max);
  const [imgA, imgB, imgDiff] = await Promise.all([
    api.imageUrl(a, { palette, scale: 2, vmin, vmax }),
    api.imageUrl(b, { palette, scale: 2, vmin, vmax }),
    api.compareImageUrl(a, b),
  ]);
  const img = (id) => (id === a ? imgA : imgB);
  const d = r.difference;
  const cls = (v) => (v > 0.05 ? "up" : v < -0.05 ? "down" : "");
  out.append(h(`<div>
      <div class="compare-grid">
        <figure><img src="${img(a)}" alt="A"><figcaption><b>A</b> · <a href="#/snapshot/${a}">${esc(sa.title || "Zonder titel")}</a> · ${fmtDate(sa.taken_at)} · ${fmt(r.a.min)} – ${fmt(r.a.max)}</figcaption></figure>
        <figure><img src="${img(b)}" alt="B"><figcaption><b>B</b> · <a href="#/snapshot/${b}">${esc(sb.title || "Zonder titel")}</a> · ${fmtDate(sb.taken_at)} · ${fmt(r.b.min)} – ${fmt(r.b.max)}</figcaption></figure>
        <figure><img src="${imgDiff}" alt="Verschil"><figcaption><b>B − A</b> · rood = warmer, blauw = kouder · gem. ${fmt(d.mean, 2)} · max +${d.max_increase.toFixed(1)} / ${d.max_decrease.toFixed(1)} °C</figcaption></figure>
      </div>
      <div class="panel" style="margin-top:16px"><h3>Meetpunten</h3>
        ${r.points.length ? `<table><thead><tr><th>Meetpunt</th><th>Type</th><th>A</th><th>B</th><th>Verschil</th></tr></thead><tbody>
          ${r.points.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.kind === "rect" ? "rechthoek (gem.)" : "punt"}</td><td>${fmt(p.a)}</td><td>${fmt(p.b)}</td><td class="${cls(p.delta)}">${p.delta > 0 ? "+" : ""}${p.delta.toFixed(2)} °C</td></tr>`).join("")}
          </tbody></table>` : `<p class="muted">Geen meetpunten op deze snapshots. Voeg ze toe in het detailscherm; punten met dezelfde naam worden vergeleken.</p>`}
      </div>
    </div>`));
}
