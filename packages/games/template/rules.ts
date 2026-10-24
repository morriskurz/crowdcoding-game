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

export function spawnBot(w: World): void {
  spawn(w, { kind: "bot", x: randomRange(w, 0, config.bounds), y: randomRange(w, 0, config.bounds), r: config.startSize });
}

export function botStep(w: World): void {
  const pellets = bodies(w, "pellet");
  for (const bot of bodies(w, "bot")) {
    let best: { d2: number; x: number; y: number } | null = null;
    for (const pel of pellets) {
      const d2 = (pel.x - bot.x) ** 2 + (pel.y - bot.y) ** 2;
      if (!best || d2 < best.d2) best = { d2, x: pel.x, y: pel.y };
    }
    if (best) {
      const d = Math.sqrt(best.d2) || 1;
      const s = Math.min(config.botSpeed, d);
      bot.vx = ((best.x - bot.x) / d) * s;
      bot.vy = ((best.y - bot.y) / d) * s;
    } else {
      bot.vx = 0;
      bot.vy = 0;
    }
    moveBody(bot, { bounds: arena });
  }
}

export function botEatCheck(w: World): void {
  for (const bot of bodies(w, "bot")) {
    for (const pel of bodies(w, "pellet")) {
      const d2 = (bot.x - pel.x) ** 2 + (bot.y - pel.y) ** 2;
      if (d2 < (bot.r + EAT_REACH) ** 2) { bot.r += GROWTH_PER_PELLET; despawn(w, pel.id); }
    }
  }
}

export function botFightCheck(w: World): void {
  for (const p of bodies(w, "player")) {
    for (const bot of bodies(w, "bot")) {
      const d2 = (p.x - bot.x) ** 2 + (p.y - bot.y) ** 2;
      if (p.r > bot.r * 1.2 && d2 < p.r ** 2) {
        p.r += bot.r * 0.5;
        bot.x = randomRange(w, 0, config.bounds);
        bot.y = randomRange(w, 0, config.bounds);
        bot.r = config.startSize;
      } else if (bot.r > p.r * 1.2 && d2 < bot.r ** 2) {
        bot.r += p.r * 0.5;
        p.x = 100; p.y = 100; p.r = config.startSize;
      }
    }
  }
}

const DRIFTER_TURN_TICKS = 60;

function setHeading(w: World, d: { vx: number; vy: number }): void {
  const a = randomRange(w, 0, Math.PI * 2);
  d.vx = Math.cos(a) * config.drifterSpeed;
  d.vy = Math.sin(a) * config.drifterSpeed;
}

export function spawnMote(w: World): void {
  spawn(w, { kind: "mote", x: randomRange(w, 0, config.bounds), y: randomRange(w, 0, config.bounds), r: config.moteSize });
}

export function spawnDrifter(w: World): void {
  const d = spawn(w, { kind: "drifter", x: randomRange(w, 0, config.bounds), y: randomRange(w, 0, config.bounds), r: config.drifterStart });
  setHeading(w, d);
}

export function driftStep(w: World): void {
  const list = bodies(w, "drifter");
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if ((w.tick + i * 17) % DRIFTER_TURN_TICKS === 0 || (d.vx === 0 && d.vy === 0)) setHeading(w, d);
    moveBody(d, { bounds: arena, bounce: 1 });
  }
}

export function absorbCheck(w: World): void {
  for (const d of bodies(w, "drifter")) {
    for (const m of bodies(w, "mote")) {
      const d2 = (d.x - m.x) ** 2 + (d.y - m.y) ** 2;
      if (d2 < (d.r + m.r) ** 2) {
        d.r = Math.min(config.drifterMaxRadius, d.r + config.drifterGrowth);
        despawn(w, m.id);
      }
    }
  }
}

export const rules: GameRules = {
  arena: { w: config.bounds, h: config.bounds },
  init(w) {
    for (let i = 0; i < config.pellets; i++) spawnPellet(w);
    for (let i = 0; i < config.botCount; i++) spawnBot(w);
    for (let i = 0; i < config.moteCount; i++) spawnMote(w);
    for (let i = 0; i < config.drifterCount; i++) spawnDrifter(w);
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
    botStep(w);
    magnetCheck(w);
    eatCheck(w);
    botEatCheck(w);
    botFightCheck(w);
    driftStep(w);
    absorbCheck(w);
    while (bodies(w, "pellet").length < config.pellets) spawnPellet(w);
    while (bodies(w, "mote").length < config.moteCount) spawnMote(w);
  },
};
