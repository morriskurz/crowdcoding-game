// Code-first assets. LLM writes draw fns + synth, no binaries. Q28.
// Agents edit this file only for visuals/audio.
import type { Entity } from "@tcg/shared";

// Client calls this for every entity in the snapshot.
export function drawEntity(ctx: CanvasRenderingContext2D, e: Entity): void {
  if (e.kind === "player") drawPlayer(ctx, e.x, e.y, e.r, "#7dd3fc");
  else if (e.kind === "pellet") drawPellet(ctx, e.x, e.y);
}

export function drawPlayer(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, size, 0, Math.PI * 2);
  ctx.fill();
}

export function drawPellet(ctx: CanvasRenderingContext2D, x: number, y: number): void {
  ctx.fillStyle = "#ffd54a";
  ctx.fillRect(x - 2, y - 2, 4, 4);
}

// WebAudio SFX: no files. Call on eat/death.
export function sfx(ctx: AudioContext, kind: "eat" | "die"): void {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.connect(g); g.connect(ctx.destination);
  o.frequency.value = kind === "eat" ? 660 : 110;
  g.gain.setValueAtTime(0.1, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
  o.start(); o.stop(ctx.currentTime + 0.16);
}

// 4-bar loop stub. Step sequencer, no assets.
export function musicTick(step: number): number {
  const scale = [0, 3, 5, 7, 10];
  return 220 * Math.pow(2, scale[step % scale.length] / 12);
}
