import { clamp, drawGlow, pulse, type Fx, type GameAssets, type Scene } from "@tcg/kit";
import type { Entity } from "@tcg/shared";
import { config } from "./config.js";

export const scene: Scene = {
  width: config.towerWidth,
  height: config.towerHeight,
  background: "#07050f",
  zoom: 1.4,
};

type Ents = Record<string, Entity>;

let latest: Ents = {};

// Per-player effect state, fed by snapshots (client only, never game state).
const airTop: Record<string, number> = {}; // highest point (lowest y) since leaving the ground
const landedAt: Record<string, number> = {}; // fx.time of the last hard landing (squash)
interface Popup { x: number; y: number; text: string; color: string; t0: number }
const popups: Popup[] = [];
// Spectator camera: the leader we follow, and a cut to a long fall while it lasts.
let leader: string | null = null;
let cut: { id: string; until: number } | null = null;

function playerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${(h >>> 0) % 360} 80% 65%)`;
}

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

const metres = (y: number) => Math.max(0, Math.round((config.floorY - config.playerR - y) / 10));

function topYOf(round: Entity | undefined): number {
  return num((round?.data as { topY?: unknown } | undefined)?.topY, 200);
}

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

export function drawBackground(ctx: CanvasRenderingContext2D, fx: Fx): void {
  // Zoom to the screen: about 700 px of tower height in view, never narrower than 400 px of it.
  fx.camera.zoom = clamp(Math.min(fx.camera.viewH / 700, fx.camera.viewW / 400), 0.6, 2.6);
  const g = ctx.createLinearGradient(0, 0, 0, scene.height);
  g.addColorStop(0, "#05030c");
  g.addColorStop(1, "#2a1f55");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, scene.width, scene.height);
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.font = "16px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  for (let y = config.floorY; y >= 0; y -= 200) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(scene.width, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.35)";
    ctx.fillText(`${Math.round((config.floorY - y) / 10)}m`, scene.width - 14, y - 6);
  }
  ctx.fillStyle = "#334155";
  ctx.fillRect(0, 0, 6, scene.height);
  ctx.fillRect(scene.width - 6, 0, 6, scene.height);
}

function platformColor(type: string): string {
  if (type === "ground") return "#5b6478";
  if (type === "top") return "#ffd54a";
  if (type === "moving") return "#2dd4bf";
  if (type === "beam") return "#fb923c";
  if (type === "gap") return "#a78bfa";
  return "#94a3b8";
}

function drawKill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fx: Fx): void {
  drawGlow(ctx, x + w / 2, y + h / 2, w * 0.7, "#ff2d2d", 0.35 + 0.2 * pulse(fx.time, 1.4));
  roundRectPath(ctx, x, y, w, h, 3);
  ctx.fillStyle = "#e11d48";
  ctx.fill();
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = "rgba(255,220,120,0.55)";
  ctx.lineWidth = 3;
  for (let sx = x - h; sx < x + w + h; sx += 10) {
    ctx.beginPath();
    ctx.moveTo(sx, y + h);
    ctx.lineTo(sx + h, y);
    ctx.stroke();
  }
  ctx.restore();
}

function drawPlatform(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  const d = e.data as { w?: unknown; h?: unknown; type?: unknown } | undefined;
  const w = num(d?.w, 100);
  const h = Math.max(8, num(d?.h, 12));
  const type = typeof d?.type === "string" ? d.type : "ledge";
  const x = e.x - w / 2;
  const y = e.y - h / 2;
  if (type === "kill") return drawKill(ctx, x, y, w, h, fx);
  roundRectPath(ctx, x, y, w, h, Math.min(5, h / 2));
  ctx.fillStyle = platformColor(type);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillRect(x + 3, y + 1, Math.max(0, w - 6), 2);
  if (type === "top") {
    const px = e.x + w / 2 - 8;
    const poleTop = y - 40;
    drawGlow(ctx, e.x, y, w * 0.6, "#ffd54a", 0.3 + 0.2 * pulse(fx.time, 1.2));
    ctx.strokeStyle = "#e5e7eb";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(px, y);
    ctx.lineTo(px, poleTop);
    ctx.stroke();
    ctx.fillStyle = "#ffd54a";
    ctx.beginPath();
    ctx.moveTo(px, poleTop);
    ctx.lineTo(px + 26, poleTop + 8);
    ctx.lineTo(px, poleTop + 16);
    ctx.closePath();
    ctx.fill();
  }
  if (type === "moving") {
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (const dx of [-12, 6]) {
      const cx = e.x + dx;
      ctx.beginPath();
      ctx.moveTo(cx - 5, e.y - 4);
      ctx.lineTo(cx + 3, e.y);
      ctx.lineTo(cx - 5, e.y + 4);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawPlayerBody(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  const color = playerColor(e.id);
  const r = e.r;
  // Stretch along fast vertical motion, squash for a moment after a hard landing.
  const stretch = clamp(Math.abs(e.vy) / config.maxFall, 0, 1) * 0.22;
  const since = fx.time - (landedAt[e.id] ?? -9);
  const squash = since < 0.14 ? 0.28 * (1 - since / 0.14) : 0;
  const sy = 1 + stretch - squash;
  const sx = 1 / Math.max(0.6, sy);
  drawGlow(ctx, e.x, e.y, r * 2.4, color, 0.3);
  ctx.save();
  ctx.translate(e.x, e.y + r * (1 - sy)); // squash toward the feet
  ctx.scale(sx, sy);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  if (e.id === fx.me) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  // Eyes look where the player moves.
  const look = clamp(e.vx / config.runSpeed, -1, 1) * 3;
  ctx.fillStyle = "#0b0e14";
  for (const ex of [-3.5, 3.5]) {
    ctx.beginPath();
    ctx.arc(ex + look, -2 + clamp(e.vy / 10, -1, 1) * 1.5, 1.8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function drawEntity(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  if (e.kind === "platform") drawPlatform(ctx, e, fx);
  else if (e.kind === "player") drawPlayerBody(ctx, e, fx);
}

function popup(x: number, y: number, text: string, color: string, fx: Fx): void {
  popups.push({ x, y, text, color, t0: fx.time });
  if (popups.length > 12) popups.shift();
}

export function onSnapshot(prev: Readonly<Ents> | null, next: Readonly<Ents>, fx: Fx): void {
  latest = next as Ents;
  if (!prev) return;
  const prevRound = prev["round"]?.data as { phase?: unknown } | undefined;
  const nextRound = next["round"]?.data as { phase?: unknown; winner?: unknown } | undefined;
  if (prevRound?.phase !== "results" && nextRound?.phase === "results") {
    const wid = typeof nextRound.winner === "string" ? nextRound.winner : "";
    const wEnt = next[wid];
    if (wEnt) fx.particles.emit({ x: wEnt.x, y: wEnt.y, count: 60, color: "#ffd54a", speed: 220, life: 1.2, size: 3, drag: 2 });
    fx.sfx.play(wid && wid === fx.me ? "win" : "powerup");
  }
  if (prevRound?.phase === "results" && nextRound?.phase === "play") {
    for (const k of Object.keys(airTop)) delete airTop[k];
    cut = null;
  }

  for (const p of Object.values(next)) {
    if (p.kind !== "player") continue;
    const q = prev[p.id];
    if (!q) continue;
    const mine = p.id === fx.me;
    const deathsBefore = num((q.data as { deaths?: unknown }).deaths, 0);
    const deathsNow = num((p.data as { deaths?: unknown }).deaths, 0);
    if (deathsNow > deathsBefore) {
      // Kill brick: burst where it happened, and what it cost in metres.
      fx.particles.emit({ x: q.x, y: q.y, count: 40, color: "#ff3b3b", speed: 200, life: 0.8, size: 3, drag: 2 });
      popup(q.x, q.y - 20, `LAVA  -${metres(q.y)}m`, "#ff6b6b", fx);
      if (mine) { fx.sfx.play("die"); fx.camera.shake(10, 0.45); }
      delete airTop[p.id];
      continue;
    }
    if (q.ground && !p.ground) airTop[p.id] = Math.min(q.y, p.y);
    if (!p.ground) airTop[p.id] = Math.min(airTop[p.id] ?? p.y, p.y);
    if (mine && q.ground && p.vy < -config.jumpSpeed / 2) fx.sfx.play("jump", { volume: 0.5, pitch: 0.95 + (fx.time * 7.3 % 1) * 0.1 });
    if (!q.ground && p.ground) {
      const drop = p.y - (airTop[p.id] ?? p.y);
      delete airTop[p.id];
      if (q.vy > 10) {
        landedAt[p.id] = fx.time;
        fx.particles.emit({ x: p.x, y: p.y + p.r, count: 8, color: "#cbd5e1", speed: 60, angle: -Math.PI / 2, spread: Math.PI, life: 0.35, size: 2, drag: 4, additive: false });
      }
      if (drop >= config.fallShownPx) {
        popup(p.x, p.y - 24, `-${Math.round(drop / 10)}m`, "#fca5a5", fx);
        if (mine) { fx.sfx.play("hurt", { volume: 0.6 }); fx.camera.shake(6, 0.3); }
      }
    }
  }
}

/** Spectator camera: the highest climber; cut to a long fall while it happens; the winner during results. */
export function spectateTarget(list: readonly Entity[], _names: Readonly<Record<string, string>>, fx: Fx): { x: number; y: number; focus?: string } | null {
  const players = list.filter((e) => e.kind === "player");
  if (!players.length) return null;
  const byId = (id: string | null) => (id ? players.find((p) => p.id === id) : undefined);
  const rd = latest["round"]?.data as { phase?: unknown; winner?: unknown } | undefined;
  const winner = rd?.phase === "results" && typeof rd.winner === "string" ? byId(rd.winner) : undefined;
  if (winner) return { x: winner.x, y: winner.y - 60, focus: winner.id };

  if (!cut || fx.time > cut.until || !byId(cut.id)) {
    cut = null;
    for (const p of players) {
      const top = airTop[p.id];
      if (top !== undefined && !p.ground && p.y - top >= config.fallShownPx && p.vy > 0) { cut = { id: p.id, until: fx.time + 2.5 }; break; }
    }
  }
  const falling = byId(cut?.id ?? null);
  if (falling) return { x: falling.x, y: falling.y, focus: falling.id };

  // Highest climber, with a margin so two players at the same height do not make the camera flicker.
  let best = byId(leader) ?? players[0];
  for (const p of players) if (p.y < best.y - 40) best = p;
  leader = best.id;
  return { x: best.x, y: best.y - 80, focus: best.id };
}

export function drawOverlay(ctx: CanvasRenderingContext2D, fx: Fx): void {
  // Screen space in CSS pixels (the renderer has already scaled for the device pixel ratio).
  const W = fx.camera.viewW;
  const H = fx.camera.viewH;
  const ents = Object.values(latest);
  const round = latest["round"];
  const rd = (round?.data as { ticksLeft?: unknown; round?: unknown; phase?: unknown; winner?: unknown } | undefined) ?? {};
  const totalSec = Math.max(0, Math.ceil(num(rd.ticksLeft, 0) / config.tickHz));
  const timerText = `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, "0")}`;
  const topY = topYOf(round);
  const towerM = metres(topY);
  const players = ents.filter((e) => e.kind === "player");

  // Fall and lava popups, floating up from where they happened.
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 18px system-ui, sans-serif";
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    const age = fx.time - p.t0;
    if (age > 1.6) { popups.splice(i, 1); continue; }
    const s = fx.camera.worldToScreen(p.x, p.y);
    ctx.globalAlpha = clamp(1.6 - age, 0, 1);
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    ctx.fillText(p.text, s.x + 1, s.y - age * 30 + 1);
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, s.x, s.y - age * 30);
  }
  ctx.globalAlpha = 1;

  // Timer, round, own height: top centre.
  const me = fx.me ? latest[fx.me] : undefined;
  const meBest = me ? num((me.data as { best?: unknown }).best, me.y) : 0;
  const sub = me ? `${metres(me.y)}m · best ${metres(meBest)}m / ${towerM}m` : `Round ${num(rd.round, 1)} · tower ${towerM}m`;
  // Narrow screens (phones, the vertical stream): the host's status line and buttons take the top
  // corners, so the timer moves below them and the leaderboard below the timer.
  const narrow = W < 700;
  const py = narrow ? 62 : 8;
  ctx.font = "15px system-ui, sans-serif";
  const panelW = Math.max(110, ctx.measureText(sub).width + 28);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRectPath(ctx, W / 2 - panelW / 2, py, panelW, 58, 8);
  ctx.fill();
  ctx.fillStyle = totalSec <= 10 && rd.phase === "play" ? "#fca5a5" : "#ffffff";
  ctx.font = "bold 26px system-ui, sans-serif";
  ctx.fillText(timerText, W / 2, py + 18);
  ctx.font = "15px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(sub, W / 2, py + 44);

  // Height bar: right edge.
  const barX = W - 22;
  const barTop = Math.max(narrow ? 200 : 90, H * 0.18);
  const barH = Math.max(40, H * 0.82 - barTop);
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRectPath(ctx, barX - 6, barTop - 6, 12, barH + 12, 6);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillRect(barX - 2, barTop, 4, barH);
  ctx.fillStyle = "#ffd54a";
  ctx.fillRect(barX - 10, barTop - 3, 20, 4);
  ctx.font = "13px system-ui, sans-serif";
  ctx.fillText("TOP", barX, barTop - 16);
  for (const e of players) {
    const frac = clamp((config.floorY - config.playerR - e.y) / (config.floorY - config.playerR - topY), 0, 1);
    const isMe = e.id === fx.me;
    ctx.fillStyle = playerColor(e.id);
    ctx.beginPath();
    ctx.arc(barX, barTop + barH * (1 - frac), isMe ? 8 : 6, 0, Math.PI * 2);
    ctx.fill();
    if (isMe) { ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 2; ctx.stroke(); }
  }

  // Leaderboard: top left, below the host's status lines. Wins this session, then best height this round.
  const winsOf = (e: Entity) => num((e.data as { wins?: unknown }).wins, 0);
  const bestOf = (e: Entity) => num((e.data as { best?: unknown }).best, e.y);
  const rows = [...players].sort((a, b) => winsOf(b) - winsOf(a) || bestOf(a) - bestOf(b)).slice(0, 5);
  ctx.textAlign = "left";
  ctx.font = "15px system-ui, sans-serif";
  const texts = rows.map((e, i) => `${i + 1}. ${fx.names?.[e.id] ?? "player"}  ${metres(bestOf(e))}m${winsOf(e) ? `  ★${winsOf(e)}` : ""}`);
  const lbW = Math.min(narrow ? W * 0.55 : W * 0.4, Math.max(120, ...texts.map((t) => ctx.measureText(t).width)) + 24);
  const lbX = 8;
  const lbY = narrow ? py + 66 : 48;
  if (rows.length) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    roundRectPath(ctx, lbX, lbY, lbW, rows.length * 22 + 12, 8);
    ctx.fill();
    rows.forEach((e, i) => {
      ctx.fillStyle = e.id === fx.me ? "#7dd3fc" : "#ffffff";
      ctx.fillText(texts[i], lbX + 12, lbY + 17 + i * 22, lbW - 20);
    });
  }

  if (rd.phase === "results") {
    const wid = typeof rd.winner === "string" ? rd.winner : "";
    const name = wid ? (fx.names?.[wid] ?? "player") : "";
    const wEnt = wid ? latest[wid] : undefined;
    const reached = wEnt ? num((wEnt.data as { best?: unknown }).best, Infinity) <= topY + 1 : false;
    const text = !wid ? "Time up, nobody climbed" : reached ? `${name} reached the top!` : `Time up, ${name} climbed highest`;
    ctx.textAlign = "center";
    ctx.font = "bold 32px system-ui, sans-serif";
    const bw = Math.min(W - 16, ctx.measureText(text).width + 48);
    const by = H / 2 - 38;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    roundRectPath(ctx, W / 2 - bw / 2, by, bw, 76, 12);
    ctx.fill();
    const cy = by - 14 + pulse(fx.time, 1.2) * 6;
    const cx = W / 2;
    ctx.fillStyle = "#ffd54a";
    ctx.beginPath();
    ctx.moveTo(cx - 26, cy + 12);
    ctx.lineTo(cx - 26, cy - 8);
    ctx.lineTo(cx - 13, cy + 2);
    ctx.lineTo(cx, cy - 12);
    ctx.lineTo(cx + 13, cy + 2);
    ctx.lineTo(cx + 26, cy - 8);
    ctx.lineTo(cx + 26, cy + 12);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#ffffff";
    ctx.fillText(text, W / 2, H / 2 + 2, W - 40);
  }
  ctx.restore();
}

export const assets = { scene, drawBackground, drawEntity, drawOverlay, onSnapshot, spectateTarget } satisfies GameAssets<Entity>;
