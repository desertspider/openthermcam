// Backend for the PC: the Python server (REST + WebSocket).

const MSG_H264 = 1, MSG_TEMP = 2;

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try { detail = (await res.json()).detail || detail; } catch { /* not json */ }
    throw new Error(typeof detail === "string" ? detail : JSON.stringify(detail));
  }
  return res.headers.get("content-type")?.includes("json") ? res.json() : res;
}

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();

export function createRemoteBackend() {
  return {
    kind: "remote",
    status: () => request("GET", "/api/status"),
    livePoints: () => request("GET", "/api/live/points"),
    setLivePoints: (pts) => request("PUT", "/api/live/points", pts),
    snapshot: (body) => request("POST", "/api/snapshots", body),
    list: (params = {}) => request("GET", "/api/snapshots?" + qs(params)),
    get: (id) => request("GET", `/api/snapshots/${id}`),
    update: (id, body) => request("PATCH", `/api/snapshots/${id}`, body),
    remove: (id) => request("DELETE", `/api/snapshots/${id}`),
    setPoints: (id, pts) => request("PUT", `/api/snapshots/${id}/points`, pts),
    compare: (a, b) => request("GET", `/api/compare?a=${a}&b=${b}`),
    tags: () => request("GET", "/api/tags"),
    pointNames: () => request("GET", "/api/point-names"),
    trend: (name, tag = "") => request("GET", "/api/trend?" + qs({ name, tag })),
    importFolder: (folder) => request("POST", "/api/import", { folder }),
    async matrix(id) {
      const res = await request("GET", `/api/snapshots/${id}/matrix`);
      const [rows, cols] = res.headers.get("X-Shape").split("x").map(Number);
      return { data: new Float32Array(await res.arrayBuffer()), rows, cols };
    },
    async imageUrl(id, { palette = "ironbow", scale = 1, vmin, vmax } = {}) {
      return `/api/snapshots/${id}/image?` + qs({ palette, scale, vmin, vmax });
    },
    async thumbUrl(id, palette = "ironbow") {
      return `/api/snapshots/${id}/image?` + qs({ palette, scale: 1 });
    },
    async compareImageUrl(a, b) {
      return `/api/compare/image?a=${a}&b=${b}&scale=2`;
    },
    async visualUrl(id) {
      return `/api/snapshots/${id}/file?visual=true`;
    },
    async downloadSnapshot(id) {
      const a = document.createElement("a");
      a.href = `/api/snapshots/${id}/file`;
      a.download = `${id}.jpg`;
      a.click();
    },
    openLive({ onTemp, onVideo, onStatus }) {
      let ws, closed = false;
      const connect = () => {
        ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/live`);
        ws.binaryType = "arraybuffer";
        ws.onmessage = (ev) => {
          if (typeof ev.data === "string") {
            try { onStatus?.(JSON.parse(ev.data)); } catch { /* ignore */ }
            return;
          }
          const type = new Uint8Array(ev.data, 0, 1)[0];
          if (type === MSG_TEMP) onTemp(new Uint16Array(ev.data.slice(1)));
          else if (type === MSG_H264) onVideo(new Uint8Array(ev.data, 1));
        };
        ws.onclose = () => { if (!closed) setTimeout(connect, 1500); };
      };
      connect();
      return () => { closed = true; ws?.close(); };
    },
  };
}
