// Agent-editable rules. Pure functions only. See guard script for banned APIs.
// Game: top-down agar. Move, eat pellets, grow.
// Feature #1 (shipped, poll 4v1): double growth per pellet (was 0.5).
// Feature #2 (parallel agent B): magnet pellets drift toward nearest living player.
import { bodies, despawn, moveBody, randomRange, spawn, type Box, type GameRules, type World } from "@tcg/shared";
import { config } from "./config.js";

export const GROWTH_PER_PELLET = 1.0;
export const MAGNET_RADIUS = 80;
export const MAGNET_PULL = 1.5;
const EAT_REACH = 4;

const arena: Box = { x: 0, y: 0, w: config.bounds, h: config.bounds };

export function spawnPellet(w: World): void {
  spawn(w, { kind: "pellet", x: randomRange(w, 0, config.bounds), y: randomRange(w, 0, config.bounds), r: 2 });
}

export function magnetCheck(w: World): void {
  const players = bodies(w, "player");
  for (const pel of bodies(w, "pellet")) {
    let best: { d2: number; x: number; y: number } | null = null;
    for (const p of players) {
      const d2 = (p.x - pel.x) ** 2 + (p.y - pel.y) ** 2;
      if (d2 < MAGNET_RADIUS ** 2 && (!best || d2 < best.d2)) best = { d2, x: p.x, y: p.y };
    }
    if (best) {
      const d = Math.sqrt(best.d2) || 1;
      pel.x += ((best.x - pel.x) / d) * Math.min(MAGNET_PULL, d);
      pel.y += ((best.y - pel.y) / d) * Math.min(MAGNET_PULL, d);
    }
  }
}

export function eatCheck(w: World): void {
  for (const p of bodies(w, "player")) {
    for (const pel of bodies(w, "pellet")) {
      const d2 = (p.x - pel.x) ** 2 + (p.y - pel.y) ** 2;
      if (d2 < (p.r + EAT_REACH) ** 2) { p.r += GROWTH_PER_PELLET; despawn(w, pel.id); }
    }
  }
}

export const rules: GameRules = {
  init(w) {
    for (let i = 0; i < config.pellets; i++) spawnPellet(w);
  },
  join(w, playerId) {
    spawn(w, { id: playerId, kind: "player", x: 100, y: 100, r: config.startSize });
  },
  step(w, inputs) {
    for (const p of bodies(w, "player")) {
      const inp = inputs[p.id];
      p.vx = (inp?.dx ?? 0) * config.speed;
      p.vy = (inp?.dy ?? 0) * config.speed;
      moveBody(p, { bounds: arena });
    }
    magnetCheck(w);
    eatCheck(w);
    while (bodies(w, "pellet").length < config.pellets) spawnPellet(w);
  },
};
