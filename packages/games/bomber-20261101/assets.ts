import { clamp, drawGlow, pulse, type Fx, type GameAssets, type NameStyle, type Scene } from "@tcg/kit";
import type { Entity } from "@tcg/shared";
import { config } from "./config.js";

const C = config.cell;
const COLS = config.cols;
const ROWS = config.rows;

export const scene: Scene = {
  width: COLS * C,
  height: ROWS * C,
  background: "#0a0d1a",
  zoom: 1.2,
};

type Ents = Record<string, Entity>;

// Client-only effect state, fed by snapshots (never game state).
let latest: Ents = {};
interface Popup { x: number; y: number; text: string; color: string; t0: number; life?: number; size?: number; outline?: boolean }
const popups: Popup[] = [];
let leader: string | null = null;
const trails = new Map<string, { x: number; y: number; t: number }[]>();

function num(v: unknown, d: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : d;
}

function str(v: unknown, d: string): string {
  return typeof v === "string" ? v : d;
}

function dataOf(e: Entity | undefined): Record<string, unknown> {
  return (e?.data as Record<string, unknown> | undefined) ?? {};
}

function playerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${(h >>> 0) % 360} 85% 62%)`;
}

function trailColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${(h >>> 0) % 360} 90% 80%)`;
}

const centre = (c: number) => c * C + C / 2;

function roundRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
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

function tilesOf(round: Entity | undefined): string {
  const t = dataOf(round).tiles;
  return typeof t === "string" && t.length === COLS * ROWS ? t : "";
}

// --- world -----------------------------------------------------------------------------------------------

function drawWall(ctx: CanvasRenderingContext2D, x: number, y: number, outer: boolean): void {
  ctx.fillStyle = outer ? "#1e2540" : "#2c3557";
  ctx.fillRect(x, y, C, C);
  ctx.fillStyle = outer ? "#283154" : "#3d4877";
  ctx.fillRect(x + 3, y + 3, C - 6, C - 6);
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(x + 3, y + 3, C - 6, 3);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(x + 3, y + C - 6, C - 6, 3);
}

function drawBrick(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = "#7a3b1d";
  ctx.fillRect(x + 1, y + 1, C - 2, C - 2);
  ctx.fillStyle = "#b8612e";
  const rowH = (C - 2) / 3;
  for (let r = 0; r < 3; r++) {
    const off = r % 2 === 0 ? 0 : (C - 2) / 4;
    const by = y + 1 + r * rowH;
    for (let bx = -off; bx < C - 2; bx += (C - 2) / 2) {
      const x0 = Math.max(0, bx) + x + 1;
      const x1 = Math.min(C - 2, bx + (C - 2) / 2) + x + 1;
      ctx.fillRect(x0 + 1, by + 1, Math.max(0, x1 - x0 - 2), rowH - 2);
    }
  }
  ctx.fillStyle = "rgba(255,220,180,0.18)";
  ctx.fillRect(x + 2, y + 2, C - 4, 2);
}

export function drawBackground(ctx: CanvasRenderingContext2D, fx: Fx): void {
  // Fit the whole arena on screen, leaving room for the HUD at the top.
  fx.camera.zoom = clamp(Math.min(fx.camera.viewW / (scene.width + 24), (fx.camera.viewH - 90) / (scene.height + 24)), 0.4, 3);
  const tiles = tilesOf(latest["round"]);
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      const x = cx * C, y = cy * C;
      const t = tiles ? tiles[cy * COLS + cx] : cx === 0 || cy === 0 || cx === COLS - 1 || cy === ROWS - 1 || (cx % 2 === 0 && cy % 2 === 0) ? "#" : ".";
      if (t === "#") drawWall(ctx, x, y, cx === 0 || cy === 0 || cx === COLS - 1 || cy === ROWS - 1);
      else {
        ctx.fillStyle = (cx + cy) % 2 === 0 ? "#2f6b3a" : "#2a6234";
        ctx.fillRect(x, y, C, C);
        if (t !== ".") drawBrick(ctx, x, y);
      }
    }
  }
}

function drawTrail(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  const id = e.id;
  let pts = trails.get(id);
  if (!pts) {
    pts = [];
    trails.set(id, pts);
  }
  if (pts.length > 0) {
    const last = pts[pts.length - 1];
    if (Math.hypot(e.x - last.x, e.y - last.y) > C) pts.length = 0;
  }
  if (pts.length === 0) {
    pts.push({ x: e.x, y: e.y, t: fx.time });
  } else {
    const last = pts[pts.length - 1];
    if (fx.time - last.t >= 0.1 && (e.x !== last.x || e.y !== last.y)) {
      pts.push({ x: e.x, y: e.y, t: fx.time });
    }
  }
  while (pts.length > 0 && fx.time - pts[0].t > 2) pts.shift();
  while (pts.length > 20) pts.shift();
  trails.set(id, pts);
  const line = [...pts, { x: e.x, y: e.y, t: fx.time }];
  if (line.length < 2) return;
  ctx.lineWidth = 1;
  ctx.strokeStyle = trailColor(id);
  for (let i = 0; i < line.length - 1; i++) {
    const age = fx.time - line[i].t;
    const alpha = Math.max(0, 0.6 * (1 - age / 2));
    if (alpha <= 0) continue;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(line[i].x, line[i].y);
    ctx.lineTo(line[i + 1].x, line[i + 1].y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawPlayer(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  const d = dataOf(e);
  const color = playerColor(e.id);
  const r = e.r;
  const dead = d.dead === true;
  const protect = num(d.protect, 0);
  ctx.save();
  drawTrail(ctx, e, fx);
  if (dead) {
    // Ghost: faded, floating, X eyes.
    const bob = Math.sin(fx.time * 4 + e.x) * 3;
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(e.x, e.y - 6 + bob, r, Math.PI, 0);
    ctx.lineTo(e.x + r, e.y + r - 6 + bob);
    for (let i = 0; i < 4; i++) ctx.lineTo(e.x + r - (i + 0.5) * (r / 2), e.y + r - 6 + bob - (i % 2 === 0 ? 5 : 0));
    ctx.lineTo(e.x - r, e.y + r - 6 + bob);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 0.7;
    ctx.strokeStyle = "#0b0e14";
    ctx.lineWidth = 2;
    for (const ex of [-5, 5]) {
      ctx.beginPath();
      ctx.moveTo(e.x + ex - 2.5, e.y - 9 + bob);
      ctx.lineTo(e.x + ex + 2.5, e.y - 4 + bob);
      ctx.moveTo(e.x + ex + 2.5, e.y - 9 + bob);
      ctx.lineTo(e.x + ex - 2.5, e.y - 4 + bob);
      ctx.stroke();
    }
    ctx.restore();
    return;
  }
  if (protect > 0) {
    ctx.globalAlpha = Math.sin(fx.time * 28) > 0 ? 1 : 0.35;
    drawGlow(ctx, e.x, e.y, r * 2.2, "#9be7ff", 0.5);
  } else drawGlow(ctx, e.x, e.y, r * 2, color, 0.25);
  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.beginPath();
  ctx.ellipse(e.x, e.y + r * 0.85, r * 0.8, r * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(e.x - r * 0.35, e.y - r * 0.35, r * 0.1, e.x, e.y, r);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(0.25, color);
  g.addColorStop(1, color);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
  ctx.fill();
  if (e.id === fx.me) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  if (protect > 0) {
    ctx.strokeStyle = "#bdf4ff";
    ctx.lineWidth = 2;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -fx.time * 20;
    ctx.beginPath();
    ctx.arc(e.x, e.y, r + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const bonus = num(d.bonus, 0);
  if (bonus > 0) {
    ctx.strokeStyle = "#ffd54a";
    ctx.lineWidth = 3;
    ctx.globalAlpha = 0.75 + 0.25 * Math.sin(fx.time * 5);
    ctx.beginPath();
    ctx.arc(e.x, e.y, r + 6 + Math.sin(fx.time * 5) * 1.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#ffd54a";
    ctx.fillText(`x${(1 + bonus / 100).toFixed(1)}`, e.x, e.y - r - 14);
  }
  // Eyes look where the player walks.
  const lx = clamp(e.vx, -1, 1) * 3, ly = clamp(e.vy, -1, 1) * 3;
  ctx.fillStyle = "#0b0e14";
  for (const ex of [-4.5, 4.5]) {
    ctx.beginPath();
    ctx.arc(e.x + ex + lx, e.y - 2 + ly, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  if (num(d.crown, 0) > 0) {
    const bob = Math.sin(fx.time * 4 + e.x) * 2;
    const crownY = e.y - r - 2 + bob;
    ctx.globalAlpha = clamp(num(d.crown, 0) / 15, 0, 1);
    drawGlow(ctx, e.x, crownY, 21, "#ffd23a", 0.5);
    ctx.fillStyle = "#ffd23a";
    ctx.strokeStyle = "#b8860b";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(e.x - 16.5, crownY - 6);
    ctx.lineTo(e.x - 16.5, crownY - 13.5);
    ctx.lineTo(e.x - 8.25, crownY - 6);
    ctx.lineTo(e.x, crownY - 21);
    ctx.lineTo(e.x + 8.25, crownY - 6);
    ctx.lineTo(e.x + 16.5, crownY - 13.5);
    ctx.lineTo(e.x + 16.5, crownY - 6);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "#ffd23a";
    ctx.fillRect(e.x - 16.5, crownY - 6, 33, 6);
    ctx.strokeRect(e.x - 16.5, crownY - 6, 33, 6);
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(e.x - 16.5, crownY - 13.5, 2.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.arc(e.x + 16.5, crownY - 13.5, 2.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#e0245e";
    ctx.beginPath();
    ctx.arc(e.x, crownY - 21, 2.7, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

function drawBomb(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  const d = dataOf(e);
  const fuseMax = Math.max(1, num(d.fuseMax, config.fuseTicks));
  const left = clamp(num(d.fuse, fuseMax) / fuseMax, 0, 1);
  // Pulses faster and swells as the fuse burns down; glows red in the last second.
  const rate = 4 + (1 - left) * 18;
  const s = 1 + 0.08 * Math.sin(fx.time * rate) + (1 - left) * 0.08;
  const r = e.r * s;
  const late = left < 1 / 3;
  if (late) drawGlow(ctx, e.x, e.y, r * 2.4, "#ff3b1f", 0.35 + 0.35 * pulse(fx.time, 0.2));
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.35)";
  ctx.beginPath();
  ctx.ellipse(e.x, e.y + r * 0.9, r * 0.9, r * 0.3, 0, 0, Math.PI * 2);
  ctx.fill();
  const g = ctx.createRadialGradient(e.x - r * 0.4, e.y - r * 0.4, r * 0.1, e.x, e.y, r);
  g.addColorStop(0, late ? "#ff8a7a" : "#6b7a99");
  g.addColorStop(0.4, late ? "#5a1a14" : "#1f2638");
  g.addColorStop(1, "#05070d");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
  ctx.fill();
  // Cap and a fuse that shrinks as it burns.
  ctx.fillStyle = "#4b5563";
  ctx.fillRect(e.x + r * 0.35, e.y - r * 1.05, r * 0.45, r * 0.35);
  const fx0 = e.x + r * 0.58, fy0 = e.y - r * 1.05;
  const len = 4 + 14 * left;
  const tipX = fx0 + len * 0.6, tipY = fy0 - len * 0.8;
  ctx.strokeStyle = "#d6c7a1";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(fx0, fy0);
  ctx.quadraticCurveTo(fx0 + len * 0.1, fy0 - len * 0.7, tipX, tipY);
  ctx.stroke();
  const flick = 0.6 + 0.4 * Math.sin(fx.time * 47 + e.x);
  drawGlow(ctx, tipX, tipY, 10 + 4 * flick, "#ffb238", 0.9);
  ctx.fillStyle = "#fff6c2";
  ctx.beginPath();
  ctx.arc(tipX, tipY, 2 + flick, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawBlast(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  const d = dataOf(e);
  const life = clamp(num(d.ticksLeft, 0) / config.blastTicks, 0, 1);
  const cx = e.x, cy = e.y;
  const up = num(d.up, 0), down = num(d.down, 0), left = num(d.left, 0), right = num(d.right, 0);
  const wob = 1 + 0.06 * Math.sin(fx.time * 40 + cx);
  const layers: Array<[number, string]> = [[0.9, "#ff4d1a"], [0.62, "#ffa62b"], [0.32, "#fff3b0"]];
  ctx.save();
  ctx.globalAlpha = 0.25 + 0.75 * life;
  drawGlow(ctx, cx, cy, C * 1.6, "#ff7a1a", 0.8 * life);
  for (const [share, color] of layers) {
    const w = C * share * (0.55 + 0.45 * life) * wob;
    ctx.fillStyle = color;
    roundRectPath(ctx, cx - left * C - w / 2, cy - w / 2, (left + right) * C + w, w, w / 2);
    ctx.fill();
    roundRectPath(ctx, cx - w / 2, cy - up * C - w / 2, w, (up + down) * C + w, w / 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawPickup(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  const bob = Math.sin(fx.time * 3 + e.x) * 2;
  const s = C * 0.62;
  drawGlow(ctx, e.x, e.y + bob, s, "#ffb238", 0.4 + 0.2 * pulse(fx.time, 1));
  ctx.save();
  roundRectPath(ctx, e.x - s / 2, e.y - s / 2 + bob, s, s, 6);
  ctx.fillStyle = "#3b1d63";
  ctx.fill();
  ctx.strokeStyle = "#ffcf5a";
  ctx.lineWidth = 2;
  ctx.stroke();
  // Flame
  ctx.fillStyle = "#ff8a1a";
  ctx.beginPath();
  ctx.moveTo(e.x - 3, e.y + 7 + bob);
  ctx.quadraticCurveTo(e.x - 10, e.y + bob, e.x - 4, e.y - 9 + bob);
  ctx.quadraticCurveTo(e.x - 2, e.y - 2 + bob, e.x + 1, e.y - 4 + bob);
  ctx.quadraticCurveTo(e.x + 8, e.y + 1 + bob, e.x + 3, e.y + 7 + bob);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 9px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("+1", e.x + 6, e.y + 6 + bob);
  ctx.restore();
}

export function drawEntity(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  if (e.kind === "player") drawPlayer(ctx, e, fx);
  else if (e.kind === "bomb") drawBomb(ctx, e, fx);
  else if (e.kind === "blast") drawBlast(ctx, e, fx);
  else if (e.kind === "pickup") drawPickup(ctx, e, fx);
}

export function nameStyle(e: Entity, _name: string, _fx: Fx): NameStyle {
  const dead = dataOf(e).dead === true;
  return { color: playerColor(e.id), alpha: dead ? 0.4 : 1, dy: -2, size: 12 };
}

// --- snapshot effects ------------------------------------------------------------------------------------

function popup(x: number, y: number, text: string, color: string, fx: Fx, life = 1.4, size?: number, outline?: boolean): void {
  popups.push({ x, y, text, color, t0: fx.time, life, size, outline });
  if (popups.length > 40) popups.shift();
}

function nearMe(next: Readonly<Ents>, x: number, y: number, fx: Fx): number {
  const me = fx.me ? next[fx.me] : undefined;
  if (!me) return 0.6;
  const dist = Math.hypot(me.x - x, me.y - y);
  return clamp(1 - dist / 700, 0.25, 1);
}

export function onSnapshot(prev: Readonly<Ents> | null, next: Readonly<Ents>, fx: Fx): void {
  latest = next as Ents;
  if (!prev) return;
  const pr = dataOf(prev["round"]), nr = dataOf(next["round"]);
  if (pr.phase !== "results" && nr.phase === "results") {
    const wid = str(nr.winner, "");
    const wEnt = next[wid];
    if (wEnt) fx.particles.emit({ x: wEnt.x, y: wEnt.y, count: 70, color: "#ffd54a", speed: 240, life: 1.3, size: 3, drag: 2 });
    fx.sfx.play(wid && wid === fx.me ? "win" : "powerup");
  }
  if (pr.phase === "results" && nr.phase === "play") popups.length = 0;

  // Broken bricks: debris where a block turned into floor.
  const t0 = tilesOf(prev["round"]), t1 = tilesOf(next["round"]);
  if (t0 && t1 && pr.round === nr.round) {
    for (let i = 0; i < t1.length; i++) {
      if (t0[i] === t1[i] || t1[i] !== ".") continue;
      const x = centre(i % COLS), y = centre(Math.floor(i / COLS));
      fx.particles.emit({ x, y, count: 14, color: "#b8612e", speed: 140, life: 0.7, size: 3, drag: 3, gravity: 200, additive: false });
    }
  }

  for (const e of Object.values(next)) {
    if (prev[e.id]) continue;
    if (e.kind === "bomb" && str(dataOf(e).owner, "") === fx.me) fx.sfx.play("click", { volume: 0.6 });
    if (e.kind === "blast") {
      const d = dataOf(e);
      const vol = nearMe(next, e.x, e.y, fx);
      fx.sfx.play("explode", { volume: vol, pitch: 0.9 + ((e.x + e.y) % 7) * 0.03 });
      if (vol > 0.6) fx.camera.shake(6 + 6 * vol, 0.35);
      fx.particles.emit({ x: e.x, y: e.y, count: 30, color: "#ffb238", speed: 220, life: 0.6, size: 4, drag: 3 });
      const arms: Array<[number, number, number]> = [[0, -1, num(d.up, 0)], [0, 1, num(d.down, 0)], [-1, 0, num(d.left, 0)], [1, 0, num(d.right, 0)]];
      for (const [dx, dy, n] of arms) {
        for (let k = 1; k <= n; k++) {
          fx.particles.emit({ x: e.x + dx * k * C, y: e.y + dy * k * C, count: 8, color: k === n ? "#ff4d1a" : "#ff9a2e", speed: 90, vx: dx * 120, vy: dy * 120, life: 0.45, size: 4, drag: 3 });
        }
      }
    }
  }

  for (const e of Object.values(prev)) {
    if (e.kind !== "pickup" || next[e.id]) continue;
    // Collected (not burnt): somebody stands on it now.
    for (const p of Object.values(next)) {
      if (p.kind !== "player" || Math.abs(p.x - e.x) > C / 2 || Math.abs(p.y - e.y) > C / 2) continue;
      fx.particles.emit({ x: e.x, y: e.y, count: 16, color: "#ffcf5a", speed: 120, life: 0.5, size: 3, drag: 3 });
      if (p.id === fx.me) { fx.sfx.play("pickup"); popup(e.x, e.y - 16, "BLAST +1", "#ffcf5a", fx); }
      break;
    }
  }

  for (const p of Object.values(next)) {
    if (p.kind !== "player") continue;
    const q = prev[p.id];
    if (!q) continue;
    const a = dataOf(q), b = dataOf(p);
    const mine = p.id === fx.me;
    if (num(b.deaths, 0) > num(a.deaths, 0)) {
      fx.particles.emit({ x: p.x, y: p.y, count: 40, color: playerColor(p.id), speed: 220, life: 0.9, size: 3, drag: 2 });
      fx.sfx.play(mine ? "die" : "hurt", { volume: mine ? 1 : 0.45 * nearMe(next, p.x, p.y, fx) });
      if (mine) fx.camera.shake(12, 0.5);
      const killer = str(b.killer, "");
      if (killer) {
        popup(p.x, p.y - 48, `+1 ${fx.names?.[killer] ?? "player"}`, playerColor(killer), fx, 1.5, 22, true);
      } else {
        popup(p.x, p.y - 18, "KO!", "#ff6b6b", fx);
      }
      const killerEnt = killer ? next[killer] : undefined;
      if (killerEnt && num(dataOf(killerEnt).bonus, 0) > 0) {
        const links = Math.max(0, num(dataOf(killerEnt).chain, 0) - 3);
        for (let k = 0; k < links; k++) {
          fx.particles.emit({ x: p.x, y: p.y, count: 18, color: "#ffd54a", speed: 200 + k * 15, life: 0.8, size: 3, drag: 2 });
        }
      }
    }
    if (num(b.ko, 0) > num(a.ko, 0)) {
      popup(p.x, p.y - 30, `+${num(b.ko, 0) - num(a.ko, 0)} KO`, "#ffd54a", fx);
      if (mine) fx.sfx.play("coin");
    }
    if (num(b.chainSeq, 0) > num(a.chainSeq, 0)) {
      const bonus = num(b.bonus, 0);
      popup(p.x, p.y - 34, bonus > 0 ? `${num(b.chain, 0)} chain +${bonus}%` : `${num(b.chain, 0)} chain`, playerColor(p.id), fx, 3, 22, true);
    }
    if (a.dead === true && b.dead !== true && mine) fx.sfx.play("powerup", { volume: 0.5 });
  }
}

/** Spectator camera: the winner during results, else the biggest bunch of bombs, else the top scorer. */
export function spectateTarget(list: readonly Entity[], _names: Readonly<Record<string, string>>, _fx: Fx): { x: number; y: number; focus?: string } | null {
  const players = list.filter((e) => e.kind === "player");
  const rd = dataOf(latest["round"]);
  if (rd.phase === "results") {
    const w = players.find((p) => p.id === rd.winner);
    if (w) return { x: w.x, y: w.y, focus: w.id };
  }
  const bombs = list.filter((e) => e.kind === "bomb");
  if (bombs.length) {
    let best: Entity[] = [];
    for (const b of bombs) {
      const near = bombs.filter((o) => Math.abs(o.x - b.x) + Math.abs(o.y - b.y) <= 3 * C);
      if (near.length > best.length) best = near;
    }
    const x = best.reduce((s, b) => s + b.x, 0) / best.length;
    const y = best.reduce((s, b) => s + b.y, 0) / best.length;
    const owner = str(dataOf(best[0]).owner, "");
    return { x, y, focus: players.some((p) => p.id === owner) ? owner : undefined };
  }
  if (!players.length) return null;
  const ko = (e: Entity) => num(dataOf(e).ko, 0);
  let top = players.find((p) => p.id === leader) ?? players[0];
  for (const p of players) if (ko(p) > ko(top)) top = p;
  leader = top.id;
  return { x: top.x, y: top.y, focus: top.id };
}

// --- HUD -------------------------------------------------------------------------------------------------

function panel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha = 0.6): void {
  ctx.fillStyle = `rgba(0,0,0,${alpha})`;
  roundRectPath(ctx, x, y, w, h, 8);
  ctx.fill();
}

export function drawOverlay(ctx: CanvasRenderingContext2D, fx: Fx): void {
  const W = fx.camera.viewW;
  const H = fx.camera.viewH;
  const rd = dataOf(latest["round"]);
  const players = Object.values(latest).filter((e) => e.kind === "player");
  const name = (id: string) => fx.names?.[id] ?? "player";
  const score = (e: Entity) => num(dataOf(e).score, 0);
  const fmt = (s: number) => String(Math.round(s * 10) / 10);
  const deaths = (e: Entity) => num(dataOf(e).deaths, 0);
  const ranked = [...players].sort((a, b) => score(b) - score(a) || deaths(a) - deaths(b) || (a.id < b.id ? -1 : 1));
  const me = fx.me ? latest[fx.me] : undefined;

  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  // Popups float up from where they happened.
  ctx.font = "bold 17px system-ui, sans-serif";
  for (let i = popups.length - 1; i >= 0; i--) {
    const p = popups[i];
    const age = fx.time - p.t0;
    const life = p.life ?? 1.4;
    if (age > life) { popups.splice(i, 1); continue; }
    const s = fx.camera.worldToScreen(p.x, p.y);
    ctx.globalAlpha = clamp(1 - age / life, 0, 1);
    const py = s.y - age * 28;
    if (p.size) ctx.font = `bold ${p.size}px system-ui, sans-serif`;
    if (p.outline) {
      ctx.lineJoin = "round";
      ctx.lineWidth = 5;
      ctx.strokeStyle = "rgba(0,0,0,0.85)";
      ctx.strokeText(p.text, s.x, py);
    } else {
      ctx.fillStyle = "rgba(0,0,0,0.6)";
      ctx.fillText(p.text, s.x + 1, py + 1);
    }
    ctx.fillStyle = p.color;
    ctx.fillText(p.text, s.x, py);
    if (p.size) ctx.font = "bold 17px system-ui, sans-serif";
  }
  ctx.globalAlpha = 1;

  // Timer + own knockouts: top centre (below the host's status line on narrow screens).
  const narrow = W < 700;
  const py = narrow ? 62 : 8;
  const play = rd.phase !== "results";
  const secs = Math.max(0, Math.ceil(num(rd.ticksLeft, 0) / config.tickHz));
  const timer = play ? `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}` : "RESULTS";
  const myRank = me ? ranked.findIndex((p) => p.id === me.id) + 1 : 0;
  const sub = me ? `Your score: ${fmt(score(me))}  ·  #${myRank} of ${ranked.length}` : `Round ${num(rd.round, 1)}  ·  ${players.length} bombers`;
  ctx.font = "15px system-ui, sans-serif";
  const pw = Math.max(130, ctx.measureText(sub).width + 30);
  panel(ctx, W / 2 - pw / 2, py, pw, 58);
  ctx.font = "bold 26px system-ui, sans-serif";
  ctx.fillStyle = play && secs <= 10 ? "#fca5a5" : "#ffffff";
  ctx.fillText(timer, W / 2, py + 19);
  ctx.font = "15px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(sub, W / 2, py + 44);

  // Top 3 scoreboard: top left.
  const top = ranked.slice(0, 3);
  if (top.length && play) {
    ctx.textAlign = "left";
    ctx.font = "15px system-ui, sans-serif";
    const rows = top.map((p, i) => `${i + 1}. ${name(p.id)}`);
    const bw = Math.min(narrow ? W * 0.5 : 260, Math.max(130, ...rows.map((t) => ctx.measureText(t).width)) + 70);
    const bx = 8, by = narrow ? py + 66 : 44;
    panel(ctx, bx, by, bw, top.length * 24 + 30);
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.fillText("SCORE", bx + 12, by + 13);
    ctx.font = "15px system-ui, sans-serif";
    top.forEach((p, i) => {
      const y = by + 32 + i * 24;
      ctx.fillStyle = playerColor(p.id);
      ctx.beginPath();
      ctx.arc(bx + 18, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.id === fx.me ? "#7dd3fc" : "#ffffff";
      ctx.textAlign = "left";
      ctx.fillText(rows[i], bx + 30, y, bw - 80);
      ctx.textAlign = "right";
      ctx.fillStyle = "#ffd54a";
      ctx.fillText(fmt(score(p)), bx + bw - 12, y);
    });
  }

  // Knocked out: who did it and the respawn countdown.
  ctx.textAlign = "center";
  if (me && play && dataOf(me).dead === true) {
    const by = str(dataOf(me).killer, "");
    const left = Math.max(1, Math.ceil(num(dataOf(me).respawn, 0) / config.tickHz));
    const line1 = by ? `Knocked out by ${name(by)}` : "Knocked out!";
    ctx.font = "bold 26px system-ui, sans-serif";
    const bw = Math.min(W - 16, ctx.measureText(line1).width + 48);
    panel(ctx, W / 2 - bw / 2, H / 2 - 44, bw, 80, 0.65);
    ctx.fillStyle = "#ff8a8a";
    ctx.fillText(line1, W / 2, H / 2 - 18, W - 40);
    ctx.font = "17px system-ui, sans-serif";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(`Respawn in ${left}…`, W / 2, H / 2 + 16);
  }

  // Results: the round's table.
  if (!play) {
    const rows = ranked.slice(0, 6);
    const wid = str(rd.winner, "");
    const title = wid ? `${name(wid)} wins the round!` : "Round over: no knockouts";
    const bw = Math.min(W - 16, 380);
    const bh = 96 + rows.length * 26;
    const bx = W / 2 - bw / 2, by = Math.max(py + 66, H / 2 - bh / 2);
    panel(ctx, bx, by, bw, bh, 0.78);
    ctx.font = "bold 24px system-ui, sans-serif";
    ctx.fillStyle = "#ffd54a";
    ctx.fillText(title, W / 2, by + 26 + pulse(fx.time, 1.2) * 3, bw - 20);
    ctx.font = "bold 12px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.textAlign = "right";
    ctx.fillText("SCORE", bx + bw - 70, by + 56);
    ctx.fillText("OUT", bx + bw - 18, by + 56);
    ctx.font = "16px system-ui, sans-serif";
    rows.forEach((p, i) => {
      const y = by + 80 + i * 26;
      ctx.textAlign = "left";
      ctx.fillStyle = playerColor(p.id);
      ctx.beginPath();
      ctx.arc(bx + 22, y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = p.id === fx.me ? "#7dd3fc" : "#ffffff";
      ctx.fillText(`${i + 1}. ${name(p.id)}`, bx + 36, y, bw - 150);
      ctx.textAlign = "right";
      ctx.fillStyle = "#ffd54a";
      ctx.fillText(fmt(score(p)), bx + bw - 70, y);
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText(String(deaths(p)), bx + bw - 18, y);
    });
    ctx.textAlign = "center";
    ctx.font = "13px system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.fillText(`Next round in ${secs}…`, W / 2, by + bh - 12);
  }
  ctx.restore();
}

export const assets = { scene, drawBackground, drawEntity, drawOverlay, onSnapshot, spectateTarget, nameStyle } satisfies GameAssets<Entity>;
