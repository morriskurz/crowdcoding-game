// Code-first assets. LLM writes draw fns, no binaries. Q28.
// Agents edit this file only for visuals/audio. Use @tcg/kit for camera shake, particles,
// trails, glow and the sfx bank: see packages/kit/README.md.
import { Trail, drawGlow, pulse, type Fx, type GameAssets, type Scene } from "@tcg/kit";
import type { Entity } from "@tcg/shared";
import { config } from "./config.js";

export const scene: Scene = { width: config.bounds, height: config.bounds, background: "#0b0e14" };

const ME = "#7dd3fc";
const PELLET = "#ffd54a";
const trails = new Map<string, Trail>();
let latest: Record<string, Entity> = {};

// Stable per-player hue so everyone keeps their color between snapshots.
function playerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${(h >>> 0) % 360} 80% 65%)`;
}

export function drawBackground(ctx: CanvasRenderingContext2D, fx: Fx): void {
  ctx.fillStyle = "#11151f";
  ctx.fillRect(0, 0, scene.width, scene.height);
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = 0; x <= scene.width; x += 50) { ctx.moveTo(x, 0); ctx.lineTo(x, scene.height); }
  for (let y = 0; y <= scene.height; y += 50) { ctx.moveTo(0, y); ctx.lineTo(scene.width, y); }
  ctx.stroke();
  ctx.strokeStyle = `rgba(125,211,252,${0.25 + 0.2 * pulse(fx.time, 3)})`;
  ctx.lineWidth = 3;
  ctx.strokeRect(0, 0, scene.width, scene.height);
}

// Client calls this for every entity, every frame (world coordinates).
export function drawEntity(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  if (e.kind === "player") drawPlayer(ctx, e, e.id === fx.me ? ME : playerColor(e.id));
  else if (e.kind === "pellet") drawPellet(ctx, e, fx);
  else if (e.kind === "bot") drawBot(ctx, e, fx);
}

export function drawPlayer(ctx: CanvasRenderingContext2D, e: Entity, color: string): void {
  let t = trails.get(e.id);
  if (!t) trails.set(e.id, (t = new Trail(12, 3)));
  t.push(e.x, e.y);
  t.draw(ctx, { color, width: e.r * 1.2, alpha: 0.25, additive: true });
  drawGlow(ctx, e.x, e.y, e.r * 2.6, color, 0.35);
  const shape = (e.data as { shape?: string } | undefined)?.shape;
  if (shape === "square") {
    ctx.fillStyle = color;
    ctx.fillRect(e.x - e.r * 1.5, e.y - e.r * 1.5, e.r * 3, e.r * 3);
    ctx.beginPath();
    ctx.rect(e.x - e.r * 1.5, e.y - e.r * 1.5, e.r * 3, e.r * 3);
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 4;
    ctx.stroke();
    return;
  }
  if (shape === "triangle") {
    const r = e.r * 1.8;
    const angles = [-Math.PI / 2, Math.PI / 6, (Math.PI * 5) / 6];
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(e.x + Math.cos(angles[0]) * r, e.y + Math.sin(angles[0]) * r);
    ctx.lineTo(e.x + Math.cos(angles[1]) * r, e.y + Math.sin(angles[1]) * r);
    ctx.lineTo(e.x + Math.cos(angles[2]) * r, e.y + Math.sin(angles[2]) * r);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.8)";
    ctx.lineWidth = 4;
    ctx.stroke();
    return;
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
  ctx.fill();
}

export function drawPellet(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  const type = (e.data as { type?: string } | undefined)?.type;
  if (type === "spiked") {
    const radius = config.pelletGlowRadius + 3 * pulse(fx.time + e.x * 0.01, 1.5);
    drawGlow(ctx, e.x, e.y, radius * 1.8, "#ff5a3c", 0.25);
    drawGlow(ctx, e.x, e.y, radius, "#ff5a3c", config.pelletGlowAlpha);
    ctx.fillStyle = "#ff5a3c";
    ctx.beginPath();
    const outer = 5;
    const inner = 2;
    for (let i = 0; i < 16; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (i / 16) * Math.PI * 2;
      const px = e.x + Math.cos(a) * r;
      const py = e.y + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fill();
    return;
  }
  if (type === "sweet") {
    const radius = config.pelletGlowRadius + 3 * pulse(fx.time + e.x * 0.01, 1.5);
    drawGlow(ctx, e.x, e.y, radius * 1.8, "#6ee77a", 0.25);
    drawGlow(ctx, e.x, e.y, radius, "#6ee77a", config.pelletGlowAlpha);
    ctx.fillStyle = "#6ee77a";
    ctx.beginPath();
    ctx.arc(e.x, e.y, 4, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  const radius = config.pelletGlowRadius + 3 * pulse(fx.time + e.x * 0.01, 1.5);
  drawGlow(ctx, e.x, e.y, radius * 1.8, PELLET, 0.25);
  drawGlow(ctx, e.x, e.y, radius, PELLET, config.pelletGlowAlpha);
  ctx.fillStyle = PELLET;
  ctx.fillRect(e.x - 2, e.y - 2, 4, 4);
}

export function drawBot(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  drawGlow(ctx, e.x, e.y, e.r * 2.6, "#ff4d4d", 0.35 + 0.15 * pulse(fx.time, 2));
  const shape = (e.data as { shape?: string } | undefined)?.shape;
  if (shape === "square") {
    ctx.fillStyle = "#ff4d4d";
    ctx.fillRect(e.x - e.r * 1.5, e.y - e.r * 1.5, e.r * 3, e.r * 3);
    ctx.beginPath();
    ctx.rect(e.x - e.r * 1.5, e.y - e.r * 1.5, e.r * 3, e.r * 3);
    ctx.strokeStyle = "#7a1010";
    ctx.lineWidth = 4;
    ctx.stroke();
    return;
  }
  if (shape === "triangle") {
    const r = e.r * 1.8;
    const angles = [-Math.PI / 2, Math.PI / 6, (Math.PI * 5) / 6];
    ctx.fillStyle = "#ff4d4d";
    ctx.beginPath();
    ctx.moveTo(e.x + Math.cos(angles[0]) * r, e.y + Math.sin(angles[0]) * r);
    ctx.lineTo(e.x + Math.cos(angles[1]) * r, e.y + Math.sin(angles[1]) * r);
    ctx.lineTo(e.x + Math.cos(angles[2]) * r, e.y + Math.sin(angles[2]) * r);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = "#7a1010";
    ctx.lineWidth = 4;
    ctx.stroke();
    return;
  }
  ctx.fillStyle = "#ff4d4d";
  ctx.beginPath();
  ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#7a1010";
  ctx.lineWidth = 2;
  ctx.stroke();
}

// Pellets that vanished were eaten by the nearest player: sparkle, and a sound if it was you.
export function onSnapshot(prev: Readonly<Record<string, Entity>> | null, next: Readonly<Record<string, Entity>>, fx: Fx): void {
  latest = next as Record<string, Entity>;
  for (const id of trails.keys()) if (!next[id]) trails.delete(id);
  if (!prev) return;
  const players = Object.values(next).filter((e) => e.kind === "player" || e.kind === "bot");
  // Shake once on the first new player collision.
  outer: for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      const pa = prev[a.id];
      const pb = prev[b.id];
      if (!pa || !pb) continue;
      if (pa.kind !== "player" && pa.kind !== "bot") continue;
      if (pb.kind !== "player" && pb.kind !== "bot") continue;
      const overlappingNow = Math.hypot(a.x - b.x, a.y - b.y) < a.r + b.r;
      const overlappingBefore = Math.hypot(pa.x - pb.x, pa.y - pb.y) < pa.r + pb.r;
      if (overlappingNow && !overlappingBefore) {
        fx.camera.shake(config.collisionShakeIntensity, config.collisionShakeDuration);
        fx.sfx.play("hit", { volume: 0.5 });
        break outer;
      }
    }
  }
  for (const id in prev) {
    const pel = prev[id];
    if (pel.kind !== "pellet" || next[id]) continue;
    let eater: Entity | null = null;
    let best = Infinity;
    for (const p of players) {
      const d = (p.x - pel.x) ** 2 + (p.y - pel.y) ** 2;
      if (d < best) { best = d; eater = p; }
    }
    if (!eater || best > (eater.r + 30) ** 2) continue; // respawned/despawned, not eaten
    const mine = eater.id === fx.me;
    fx.particles.emit({ x: pel.x, y: pel.y, count: 18, color: mine ? ME : eater.kind === "bot" ? "#ff4d4d" : playerColor(eater.id), speed: 140, life: 0.6, size: 3, drag: 2 });
    fx.particles.emit({ x: pel.x, y: pel.y, count: 8, color: PELLET, speed: 90, life: 0.45, size: 2.5, drag: 2 });
    if (mine) {
      fx.sfx.play("pickup", { pitch: 0.9 + (eater.r % 10) * 0.03 });
      if (eater.r >= config.startSize + 10 && eater.r % 10 < 1) { fx.sfx.play("powerup"); fx.camera.shake(6, 0.25); }
    }
  }
}

export function drawOverlay(ctx: CanvasRenderingContext2D, fx: Fx): void {
  ctx.save();
  const S = config.minimapSize;
  const M = config.minimapMargin;
  const originX = ctx.canvas.width - S - M;
  const originY = ctx.canvas.height - S - M;
  ctx.fillStyle = `rgba(11,14,20,${config.minimapAlpha})`;
  ctx.fillRect(originX, originY, S, S);
  ctx.strokeStyle = "rgba(125,211,252,0.5)";
  ctx.lineWidth = 1;
  ctx.strokeRect(originX, originY, S, S);
  const dotMin = config.minimapDotMin;
  const dotMax = config.minimapDotMax;
  const span = config.maxSize - config.startSize;
  for (const e of Object.values(latest)) {
    if (e.kind !== "bot") continue;
    const dx = originX + (e.x / config.bounds) * S;
    const dy = originY + (e.y / config.bounds) * S;
    ctx.globalAlpha = 0.6;
    ctx.fillStyle = "#ff4d4d";
    ctx.beginPath();
    ctx.arc(dx, dy, dotMin, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  for (const e of Object.values(latest)) {
    if (e.kind !== "player") continue;
    const dx = originX + (e.x / config.bounds) * S;
    const dy = originY + (e.y / config.bounds) * S;
    let t = span === 0 ? 0 : (e.r - config.startSize) / span;
    t = Math.min(1, Math.max(0, t));
    const radius = Math.min(dotMax, Math.max(dotMin, dotMin + t * (dotMax - dotMin)));
    ctx.fillStyle = e.id === fx.me ? ME : playerColor(e.id);
    ctx.beginPath();
    ctx.arc(dx, dy, radius, 0, Math.PI * 2);
    ctx.fill();
    if (e.id === fx.me) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
  ctx.restore();
}

export const assets = { scene, drawBackground, drawEntity, drawOverlay, onSnapshot } satisfies GameAssets<Entity>;
