// Host page: owns the WebSocket (net.ts) and nothing else. The game runs in
// <iframe sandbox="allow-scripts"> (opaque origin) and talks to us only via postMessage.
// No overlay: status goes to the game page to draw, and to #banner (hidden) for scripts.
import "./host.css";
import { connect, sendInput } from "./net.js";
import { SendBudget, parseGameMessage, type HostMessage } from "./bridge.js";

const frame = document.getElementById("game") as HTMLIFrameElement;
const banner = document.getElementById("banner")!;
let ready = false;
let status: HostMessage | null = null;
let seenVersion: string | null = null;
let draining = false;
const budget = new SendBudget(8, 8, performance.now());

// ?room=main&env=preview|live&name=you&drain=60
const q = new URLSearchParams(location.search);
const roomName = (q.get("room") ?? "main").replace(/[^a-z0-9-_]/gi, "").slice(0, 32) || "main";
const env = q.get("env") === "live" ? "live" : "preview";
const name = (q.get("name") ?? "anon").slice(0, 16);

// The sandboxed frame has an opaque origin, so "*" is the only possible target. Nothing we send
// is secret: snapshots are what every player receives anyway.
function post(m: HostMessage): void {
  if (ready) frame.contentWindow?.postMessage(m, "*");
}

function setStatus(text: string): void {
  banner.textContent = text;
  status = { t: "status", text, me: ws.id ?? null, draining };
  post(status);
}

const ws = connect(roomName, (snap) => {
  if (snap.draining === true && !draining) { draining = true; setStatus("draining — new build coming, finish run"); }
  post({ t: "snap", snap });
}, (hello) => {
  if (hello.t === "drain" || hello.draining === true) {
    draining = true;
    setStatus(`draining — new build ${hello.version ?? ""}, finish run`);
    return;
  }
  if (seenVersion && hello.version && seenVersion !== hello.version) {
    const secs = Number(q.get("drain") ?? "60");
    setStatus(`new build ${hello.version} — auto-join in ${secs}s`);
    setTimeout(() => location.reload(), secs * 1000);
  } else {
    draining = false;
    setStatus(`live ${hello.version ?? "?"} [${env}:${roomName}] — WASD play`);
    seenVersion = hello.version ?? seenVersion;
  }
}, { env, name });

addEventListener("message", (e) => {
  if (e.source !== frame.contentWindow) return; // only our game frame, never other windows
  const m = parseGameMessage(e.data);
  if (!m) return;
  if (m.t === "ready") {
    ready = true;
    if (status) post({ ...status, me: ws.id ?? null } as HostMessage);
    return;
  }
  if (budget.take(performance.now())) sendInput(ws, m.dx, m.dy, m.action, m.seq);
});

// Keys pressed while the host (not the frame) has focus still reach the game.
for (const type of ["keydown", "keyup"] as const) {
  addEventListener(type, (e) => { if (!e.repeat) post({ t: "key", key: e.key.toLowerCase(), down: type === "keydown" }); });
}
frame.addEventListener("load", () => frame.focus());
