// Hash router + camera status pill.
import { api, esc, h } from "./api.js";
import { compareView } from "./compare.js";
import { libraryView } from "./library.js";
import { liveView } from "./live.js";
import { snapshotView } from "./snapshot.js";
import { trendsView } from "./trends.js";

const routes = {
  live: (root) => liveView(root),
  library: (root) => libraryView(root),
  snapshot: (root, id) => snapshotView(root, id),
  compare: (root, a, b) => compareView(root, a, b),
  trends: (root, name) => trendsView(root, name),
};

let cleanup = null;

async function route() {
  const [name, ...args] = (location.hash.replace(/^#\/?/, "") || "live").split("/");
  const fn = routes[name] || routes.live;
  document.querySelectorAll("nav a").forEach((a) => a.classList.toggle("active", a.dataset.route === (name === "snapshot" ? "library" : name)));
  if (typeof cleanup === "function") cleanup();
  cleanup = null;
  const root = document.getElementById("view");
  root.innerHTML = "";
  try {
    cleanup = await fn(root, ...args);
  } catch (e) {
    root.append(h(`<div class="panel"><b>Er ging iets mis.</b><p class="muted">${esc(e.message)}</p></div>`));
  }
}

const LABELS = { streaming: "Camera live", connecting: "Verbinden…", waiting: "Geen camera", error: "Camerafout", stopped: "Gestopt" };
async function pollStatus() {
  const pill = document.getElementById("camera-status");
  try {
    const { camera } = await api.status();
    pill.className = `pill ${camera.status}`;
    pill.textContent = LABELS[camera.status] || camera.status;
    pill.title = camera.message || `${camera.temperature_frames} temperatuurframes · ${camera.video_frames} videoframes`;
  } catch {
    pill.className = "pill error";
    pill.textContent = "Server offline";
  }
}

window.addEventListener("hashchange", route);
route();
pollStatus();
setInterval(pollStatus, 2000);
