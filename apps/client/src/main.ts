import { connect, sendInput } from "./net.js";
import { render } from "./render.js";

const canvas = document.getElementById("c") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const banner = document.getElementById("banner")!;
let seenVersion: string | null = null;
const keys = new Set<string>();

addEventListener("keydown", (e) => keys.add(e.key.toLowerCase()));
addEventListener("keyup", (e) => keys.delete(e.key.toLowerCase()));

// ?room=main&env=preview|live&name=you&drain=60
const q = new URLSearchParams(location.search);
const roomName = (q.get("room") ?? "main").replace(/[^a-z0-9-_]/gi, "").slice(0, 32) || "main";
const env = q.get("env") === "live" ? "live" : "preview";
const name = (q.get("name") ?? "anon").slice(0, 16);

const ws = connect(roomName, (snap) => {
  render(ctx, snap);
  if (snap.draining === true && !banner.textContent.startsWith("draining")) {
    banner.textContent = `draining — new build coming, finish run`;
  }
}, (hello) => {
  if (hello.t === "drain" || hello.draining === true) {
    banner.textContent = `draining — new build ${hello.version ?? ""}, finish run`;
    return;
  }
  if (seenVersion && hello.version && seenVersion !== hello.version) {
    const secs = Number(q.get("drain") ?? "60");
    banner.textContent = `new build ${hello.version} — auto-join in ${secs}s`;
    setTimeout(() => location.reload(), secs * 1000);
  } else {
    banner.textContent = `live ${hello.version ?? "?"} [${env}:${roomName}] — WASD play`;
    seenVersion = hello.version ?? seenVersion;
  }
}, { env, name });

setInterval(() => {
  const kx = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
  const ky = (keys.has("s") ? 1 : 0) - (keys.has("w") ? 1 : 0);
  sendInput(ws, kx, ky);
}, 1000 / 15);
