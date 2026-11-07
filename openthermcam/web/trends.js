// Trend of one named measurement point across all snapshots.
import { api, esc, fmt, fmtDate, h } from "./api.js";

export async function trendsView(root, name) {
  const [names, tags] = await Promise.all([api.pointNames(), api.tags()]);
  name = name ? decodeURIComponent(name) : names[0];
  const el = h(`<div>
      <div class="toolbar">
        <label class="inline">Meetpunt <select id="name">${names.map((n) => `<option ${n === name ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
        <label class="inline">Tag <select id="tag"><option value="">alle</option>${tags.map((t) => `<option>${esc(t)}</option>`).join("")}</select></label>
      </div>
      <div class="panel" id="chart"></div>
    </div>`);
  root.append(el);
  if (!names.length) {
    el.querySelector("#chart").append(h(`<p class="muted">Nog geen meetpunten in snapshots. Geef meetpunten vaste namen (bijv. "Groep 3"), dan zie je hier hoe die over tijd veranderen.</p>`));
    return;
  }
  const draw = async () => {
    const data = await api.trend(el.querySelector("#name").value, el.querySelector("#tag").value);
    const box = el.querySelector("#chart");
    box.innerHTML = "";
    if (!data.length) return box.append(h(`<p class="muted">Geen waarden.</p>`));
    const W = 900, H = 340, L = 56, R = 16, T = 16, B = 40;
    const vals = data.map((d) => d.value);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    const x = (i) => L + (data.length === 1 ? (W - L - R) / 2 : (i / (data.length - 1)) * (W - L - R));
    const y = (v) => T + (1 - (v - lo) / (hi - lo)) * (H - T - B);
    const ticks = Array.from({ length: 5 }, (_, i) => lo + ((hi - lo) * i) / 4);
    const svg = h(`<svg class="chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
        ${ticks.map((t) => `<line class="axis" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text x="${L - 6}" y="${y(t) + 4}" text-anchor="end">${t.toFixed(1)}</text>`).join("")}
        <polyline class="line" points="${data.map((d, i) => `${x(i)},${y(d.value)}`).join(" ")}"/>
        ${data.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.value)}" r="4" data-id="${d.snapshot_id}"><title>${esc(d.title)} · ${fmtDate(d.taken_at)} · ${fmt(d.value)}</title></circle>`).join("")}
        <text x="${L}" y="${H - 12}">${fmtDate(data[0].taken_at)}</text>
        <text x="${W - R}" y="${H - 12}" text-anchor="end">${fmtDate(data.at(-1).taken_at)}</text>
      </svg>`);
    svg.querySelectorAll("circle").forEach((c) => c.addEventListener("click", () => (location.hash = `#/snapshot/${c.dataset.id}`)));
    box.append(svg, h(`<p class="hint">${data.length} meting(en) · min ${fmt(Math.min(...vals))} · max ${fmt(Math.max(...vals))} · klik op een punt om de snapshot te openen</p>`));
  };
  el.querySelector("#name").addEventListener("change", draw);
  el.querySelector("#tag").addEventListener("change", draw);
  await draw();
}
