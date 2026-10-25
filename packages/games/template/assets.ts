import { drawGlow, pulse, type Fx, type GameAssets, type Scene } from "@tcg/kit";
import type { Entity } from "@tcg/shared";
import { config } from "./config.js";

export const scene: Scene = {
  width: config.towerWidth,
  height: config.towerHeight,
  background: "#120c24",
  zoom: config.cameraZoomTower,
};

let latest: Record<string, Entity> = {};

function playerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return `hsl(${(h >>> 0) % 360} 80% 65%)`;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function topYOf(round: Entity | undefined): number {
  const t = (round?.data as { topY?: number } | undefined)?.topY;
  return typeof t === "number" && Number.isFinite(t) ? t : 60;
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
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

export function drawBackground(ctx: CanvasRenderingContext2D, _fx: Fx): void {
  const g = ctx.createLinearGradient(0, 0, 0, scene.height);
  g.addColorStop(0, "#05030c");
  g.addColorStop(1, "#2a1f55");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, scene.width, scene.height);
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  ctx.font = "18px system-ui, sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "alphabetic";
  for (let y = 0; y <= scene.height; y += 150) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(scene.width, y + 0.5);
    ctx.stroke();
    const m = Math.round((config.floorY - y) / 10);
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.fillText(`${m}m`, scene.width - 14, clamp(y - 6, 20, scene.height - 6));
  }
  ctx.fillStyle = "#334155";
  ctx.fillRect(0, 0, 8, scene.height);
  ctx.fillRect(scene.width - 8, 0, 8, scene.height);
}

function platformColor(type: string | undefined): string {
  if (type === "ground") return "#5b6478";
  if (type === "top") return "#ffd54a";
  if (type === "moving") return "#2dd4bf";
  if (type === "beam") return "#fb923c";
  return "#64748b";
}

function drawPlatform(ctx: CanvasRenderingContext2D, e: Entity): void {
  const d = e.data as { w?: number; h?: number; type?: string } | undefined;
  const w = typeof d?.w === "number" && Number.isFinite(d.w) ? d.w : 100;
  const hRaw = typeof d?.h === "number" && Number.isFinite(d.h) ? d.h : 12;
  const h = Math.max(8, hRaw);
  const type = typeof d?.type === "string" ? d.type : "ledge";
  const color = platformColor(type);
  const x = e.x - w / 2;
  const y = e.y - h / 2;
  roundRectPath(ctx, x, y, w, h, Math.min(6, h / 2));
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillRect(x + 3, y + 1, Math.max(0, w - 6), 2);
  if (type === "top") {
    const px = e.x + w / 2 - 6;
    const poleTop = y - 34;
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
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    for (const dx of [-14, 6]) {
      const cx = e.x + dx;
      const cy = e.y;
      ctx.beginPath();
      ctx.moveTo(cx - 6, cy - 5);
      ctx.lineTo(cx + 4, cy);
      ctx.lineTo(cx - 6, cy + 5);
      ctx.closePath();
      ctx.fill();
    }
  }
}

function drawPlayerBody(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  const color = playerColor(e.id);
  const r = Math.max(e.r, 12);
  const vy = e.vy;
  const t = clamp(Math.abs(vy) / 16, 0, 1);
  const sx = 1 + 0.15 * t;
  const sy = 1 - 0.15 * t;
  drawGlow(ctx, e.x, e.y, r * 2.2, color, 0.35);
  ctx.save();
  ctx.translate(e.x, e.y);
  ctx.scale(sx, sy);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  if (e.id === fx.me) {
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 3 / Math.max(sx, 0.5);
    ctx.stroke();
  }
  ctx.restore();
}

export function drawEntity(ctx: CanvasRenderingContext2D, e: Entity, fx: Fx): void {
  if (e.kind === "round") return;
  if (e.kind === "platform") {
    drawPlatform(ctx, e);
    return;
  }
  if (e.kind === "pellet") {
    drawGlow(ctx, e.x, e.y, 12, "#ffd54a", 0.5);
    ctx.fillStyle = "#ffd54a";
    ctx.beginPath();
    ctx.arc(e.x, e.y, 4, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  if (e.kind === "player") {
    drawPlayerBody(ctx, e, fx);
  }
}

export function onSnapshot(
  prev: Readonly<Record<string, Entity>> | null,
  next: Readonly<Record<string, Entity>>,
  fx: Fx,
): void {
  latest = next as Record<string, Entity>;
  if (!fx.me || (next as Record<string, Entity>)[fx.me] === undefined) {
    const players = Object.values(next).filter((e) => e.kind === "player");
    if (players.length > 0) {
      let top = players[0];
      for (const p of players) if (p.y < top.y) top = p;
      fx.camera.follow(top.x, top.y + 120, !prev);
    }
  }
  if (!prev) return;
  const prevList = Object.values(prev);
  const nextList = Object.values(next);
  const prevRound = prevList.find((e) => e.kind === "round");
  const nextRound = nextList.find((e) => e.kind === "round");
  const prevPhase = (prevRound?.data as { phase?: string } | undefined)?.phase;
  const nextPhase = (nextRound?.data as { phase?: string } | undefined)?.phase;
  if (prevPhase !== "results" && nextPhase === "results" && nextRound) {
    const winner = (nextRound.data as { winner?: string } | undefined)?.winner;
    const wid = typeof winner === "string" ? winner : null;
    const wEnt = wid ? (next as Record<string, Entity>)[wid] : undefined;
    if (wEnt) {
      fx.particles.emit({
        x: wEnt.x,
        y: wEnt.y,
        count: 60,
        color: "#ffd54a",
        speed: 220,
        life: 1.2,
        size: 3,
        drag: 2,
      });
    }
    if (wid !== null && wid === fx.me) fx.sfx.play("win");
    else fx.sfx.play("powerup");
  }
  if (fx.me) {
    const pPrev = (prev as Record<string, Entity>)[fx.me];
    const pNext = (next as Record<string, Entity>)[fx.me];
    if (pPrev && pNext) {
      const dPrev = pPrev.data as { on?: unknown } | undefined;
      const prevVy = pPrev.vy;
      const nextVy = pNext.vy;
      if (dPrev?.on && prevVy >= -1 && nextVy <= -9) {
        fx.sfx.play("jump", { volume: 0.6 });
      }
      if (pNext.y - pPrev.y > 300) {
        fx.camera.shake(8, 0.4);
        fx.sfx.play("hurt", { volume: 0.6 });
      }
    }
  }
  const players = nextList.filter((e) => e.kind === "player");
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      const pa = (prev as Record<string, Entity>)[a.id];
      const pb = (prev as Record<string, Entity>)[b.id];
      if (!pa || !pb) continue;
      const nowD = Math.hypot(a.x - b.x, a.y - b.y);
      const beforeD = Math.hypot(pa.x - pb.x, pa.y - pb.y);
      if (nowD < a.r + b.r && !(beforeD < pa.r + pb.r)) {
        fx.camera.shake(config.collisionShakeIntensity, config.collisionShakeDuration);
        fx.sfx.play("hit", { volume: 0.5 });
        i = players.length;
        break;
      }
    }
  }
}

export function drawOverlay(ctx: CanvasRenderingContext2D, fx: Fx): void {
  const W = ctx.canvas.width;
  const H = ctx.canvas.height;
  const ents = Object.values(latest);
  const round = ents.find((e) => e.kind === "round");
  const rd = (round?.data as { ticksLeft?: number; round?: number; phase?: string; winner?: string } | undefined) ?? {};
  const ticksLeft = typeof rd.ticksLeft === "number" && Number.isFinite(rd.ticksLeft) ? rd.ticksLeft : 0;
  const roundNum = typeof rd.round === "number" && Number.isFinite(rd.round) ? rd.round : 1;
  const totalSec = Math.max(0, Math.ceil(ticksLeft / config.tickHz));
  const mm = Math.floor(totalSec / 60);
  const ss = String(totalSec % 60).padStart(2, "0");
  const topY = topYOf(round);

  ctx.save();
  ctx.textBaseline = "middle";

  const timerText = `${mm}:${ss}`;
  ctx.font = "bold 28px system-ui, sans-serif";
  const timerW = ctx.measureText(timerText).width;
  ctx.font = "16px system-ui, sans-serif";
  const roundText = `Round ${roundNum}`;
  const roundW = ctx.measureText(roundText).width;
  const panelW = Math.max(timerW, roundW) + 32;
  const panelH = 64;
  const px = clamp(W / 2 - panelW / 2, 8, Math.max(8, W - panelW - 8));
  const py = 8;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRectPath(ctx, px, py, panelW, panelH, 8);
  ctx.fill();
  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px system-ui, sans-serif";
  ctx.fillText(timerText, px + panelW / 2, py + 20);
  ctx.font = "16px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  ctx.fillText(roundText, px + panelW / 2, py + 48);

  const barX = W - 28;
  const barTop = H * 0.2;
  const barBottom = H * 0.8;
  const barH = barBottom - barTop;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRectPath(ctx, barX - 6, barTop - 6, 12, barH + 12, 6);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.25)";
  ctx.fillRect(barX - 2, barTop, 4, barH);
  ctx.fillStyle = "#ffd54a";
  ctx.fillRect(barX - 10, barTop - 3, 20, 4);
  ctx.font = "14px system-ui, sans-serif";
  ctx.fillStyle = "#ffd54a";
  ctx.fillText("TOP", barX, Math.max(12, barTop - 18));
  for (const e of ents) {
    if (e.kind !== "player") continue;
    const frac = clamp((config.floorY - e.y) / (config.floorY - topY), 0, 1);
    const dy = barBottom - frac * barH;
    const isMe = e.id === fx.me;
    ctx.fillStyle = playerColor(e.id);
    ctx.beginPath();
    ctx.arc(barX, clamp(dy, barTop, barBottom), isMe ? 9 : 7, 0, Math.PI * 2);
    ctx.fill();
    if (isMe) {
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 2;
      ctx.stroke();
    }
  }

  const players = ents.filter((e) => e.kind === "player");
  const winsOf = (e: Entity): number => {
    const w = (e.data as { wins?: number } | undefined)?.wins;
    return typeof w === "number" && Number.isFinite(w) ? w : 0;
  };
  const bestOf = (e: Entity): number => {
    const b = (e.data as { best?: number } | undefined)?.best;
    return typeof b === "number" && Number.isFinite(b) ? b : e.y;
  };
  players.sort((a, b) => winsOf(b) - winsOf(a) || bestOf(a) - bestOf(b));
  const rows = players.slice(0, 5);
  ctx.textAlign = "left";
  ctx.font = "16px system-ui, sans-serif";
  let maxRowW = 0;
  const rowTexts = rows.map((e, i) => {
    const name = fx.names?.[e.id] ?? "player";
    const w = winsOf(e);
    const score = w === 1 ? "1 win" : `★ ${w}`;
    return `${i + 1}. ${name}  ${score}`;
  });
  for (const t of rowTexts) maxRowW = Math.max(maxRowW, ctx.measureText(t).width);
  const lbW = Math.min(W - 16, maxRowW + 24);
  const lbH = rows.length > 0 ? rows.length * 24 + 16 : 40;
  const lbX = 8;
  const lbY = 8;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  roundRectPath(ctx, lbX, lbY, Math.max(lbW, 120), lbH, 8);
  ctx.fill();
  if (rows.length === 0) {
    ctx.fillStyle = "#ffffff";
    ctx.fillText("No players", lbX + 12, lbY + 20);
  } else {
    rows.forEach((e, i) => {
      ctx.fillStyle = e.id === fx.me ? "#7dd3fc" : "#ffffff";
      ctx.fillText(rowTexts[i], lbX + 12, lbY + 20 + i * 24);
    });
  }

  const phase = typeof rd.phase === "string" ? rd.phase : "";
  if (phase === "results") {
    const wid = typeof rd.winner === "string" ? rd.winner : null;
    const name = wid ? (fx.names?.[wid] ?? "player") : "";
    let text: string;
    if (!wid) {
      text = "Time up — no winner";
    } else {
      const wEnt = (latest as Record<string, Entity>)[wid];
      const best = (wEnt?.data as { best?: number } | undefined)?.best;
      const reached =
        typeof best === "number" && Number.isFinite(best) && best <= topY + 40;
      text = reached ? `${name} reached the top!` : `Time up — ${name} wins`;
    }
    ctx.textAlign = "center";
    ctx.font = "bold 36px system-ui, sans-serif";
    const tw = Math.min(W - 80, ctx.measureText(text).width);
    const bw = tw + 48;
    const bh = 76;
    const bx = W / 2 - bw / 2;
    const by = H / 2 - bh / 2;
    ctx.fillStyle = "rgba(0,0,0,0.7)";
    roundRectPath(ctx, clamp(bx, 8, Math.max(8, W - bw - 8)), by, bw, bh, 12);
    ctx.fill();
    const bob = pulse(fx.time, 1.2) * 6;
    const cx = W / 2;
    const cy = by - 14 + bob;
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
    ctx.fillText(text, W / 2, H / 2 + 6);
  }

  ctx.restore();
}

export const assets = { scene, drawBackground, drawEntity, drawOverlay, onSnapshot } satisfies GameAssets<Entity>;
