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

export type PelletType = "normal" | "spiked" | "sweet";
const TYPES: PelletType[] = ["normal", "spiked", "sweet"];

export function spawnPellet(w: World): void {
  const x = randomRange(w, 0, config.bounds);
  const y = randomRange(w, 0, config.bounds);
  const roll = randomRange(w, 0, 1);
  const type: PelletType = roll < config.spikedChance ? "spiked" : roll < config.spikedChance + config.sweetChance ? "sweet" : "normal";
  spawn(w, { kind: "pellet", x, y, r: 2, data: { type } });
}

function pelletType(pel: { data: object }): PelletType {
  const t = (pel.data as { type?: unknown }).type;
  return t === "spiked" || t === "sweet" ? t : "normal";
}

export function pelletGrowth(type: PelletType): number {
  return type === "spiked" ? config.spikedGrowth : type === "sweet" ? config.sweetGrowth : GROWTH_PER_PELLET;
}

// Records the eaten pellet on the player and returns the growth (with specialist bonus).
function playerGrowth(p: { data: object }, type: PelletType): number {
  const d = p.data as { eaten?: Record<PelletType, number> };
  const eaten = (d.eaten ??= { normal: 0, spiked: 0, sweet: 0 });
  eaten[type] = (eaten[type] ?? 0) + 1;
  const mine = eaten[type];
  const isTop = TYPES.every((t) => t === type || (eaten[t] ?? 0) < mine);
  const growth = pelletGrowth(type);
  const base = isTop && mine >= config.specialistMin ? growth * (1 + config.specialistBonus) : growth;
  const shape = getShape(p);
  return shape === "square" ? base * config.squareGrowthMult : shape === "triangle" ? base * config.triangleGrowthMult : base;
}

export type Shape = "circle" | "square" | "triangle";

export function getShape(p: { data: object }): Shape {
  const s = (p.data as { shape?: unknown }).shape;
  return s === "square" || s === "triangle" ? s : "circle";
}

function speedFor(p: { data: object }): number {
  const shape = getShape(p);
  return config.speed * (shape === "square" ? config.squareSpeedMult : shape === "triangle" ? config.triangleSpeedMult : 1);
}

// Players that hit max size restart small as a square or triangle.
export function shapeCheck(w: World): void {
  for (const p of bodies(w, "player")) {
    if (p.r < config.maxSize) continue;
    p.x = 100; p.y = 100; p.r = config.startSize;
    (p.data as { shape?: Shape }).shape = randomRange(w, 0, 1) < 0.5 ? "square" : "triangle";
  }
  for (const b of bodies(w, "bot")) {
    if (b.r < config.maxSize) continue;
    b.x = randomRange(w, 0, config.bounds);
    b.y = randomRange(w, 0, config.bounds);
    b.r = config.startSize;
    (b.data as { shape?: Shape }).shape = randomRange(w, 0, 1) < 0.5 ? "square" : "triangle";
  }
}

// Shaped players and circle players hunt each other when one is clearly bigger and they overlap.
export function shapeHuntCheck(w: World): void {
  const players = bodies(w, "player");
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      const aShaped = getShape(a) !== "circle";
      if (aShaped === (getShape(b) !== "circle")) continue;
      const shaped = aShaped ? a : b;
      const circle = aShaped ? b : a;
      const d2 = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
      if (shaped.r > circle.r * config.shapeHuntMargin && d2 < shaped.r ** 2) {
        shaped.r += circle.r * 0.5;
        circle.x = 100; circle.y = 100; circle.r = config.startSize;
      } else if (circle.r > shaped.r * config.shapeHuntMargin && d2 < circle.r ** 2) {
        circle.r += shaped.r * config.shapeBounty;
        shaped.x = 100; shaped.y = 100; shaped.r = config.startSize;
        delete (shaped.data as { shape?: Shape }).shape;
      }
    }
  }
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
      if (d2 < (p.r + EAT_REACH) ** 2) { p.r += playerGrowth(p, pelletType(pel)); despawn(w, pel.id); }
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
      const shape = getShape(bot);
      const mult = shape === "square" ? config.squareSpeedMult : shape === "triangle" ? config.triangleSpeedMult : 1;
      const s = Math.min(config.botSpeed * mult, d);
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
      if (d2 < (bot.r + EAT_REACH) ** 2) { bot.r += pelletGrowth(pelletType(pel)); despawn(w, pel.id); }
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
        delete (bot.data as { shape?: Shape }).shape;
      } else if (bot.r > p.r * 1.2 && d2 < bot.r ** 2) {
        bot.r += p.r * 0.5;
        p.x = 100; p.y = 100; p.r = config.startSize;
      }
    }
  }
}

// Moving circles shove overlapping players/bots away from them, harder when bigger.
export function blowbackCheck(w: World): void {
  const all = [...bodies(w, "player"), ...bodies(w, "bot")];
  const push = new Map<number, { dx: number; dy: number }>();
  for (const a of all) {
    if (!a.vx && !a.vy) continue;
    for (const b of all) {
      if (a === b) continue;
      const ddx = b.x - a.x;
      const ddy = b.y - a.y;
      const d = Math.sqrt(ddx * ddx + ddy * ddy);
      if (d >= a.r + b.r) continue;
      const ux = d > 0 ? ddx / d : 1;
      const uy = d > 0 ? ddy / d : 0;
      const amt = Math.min(config.blowbackMax, config.blowbackStrength * a.r);
      const acc = push.get(b.id as unknown as number) ?? { dx: 0, dy: 0 };
      acc.dx += ux * amt;
      acc.dy += uy * amt;
      push.set(b.id as unknown as number, acc);
    }
  }
  for (const b of all) {
    const acc = push.get(b.id as unknown as number);
    if (!acc) continue;
    b.x = Math.min(Math.max(b.x + acc.dx, b.r), config.bounds - b.r);
    b.y = Math.min(Math.max(b.y + acc.dy, b.r), config.bounds - b.r);
  }
}

export const rules: GameRules = {
  arena: { w: config.bounds, h: config.bounds },
  init(w) {
    for (let i = 0; i < config.pellets; i++) spawnPellet(w);
    for (let i = 0; i < config.botCount; i++) spawnBot(w);
  },
  join(w, playerId) {
    spawn(w, { id: playerId, kind: "player", x: 100, y: 100, r: config.startSize });
  },
  step(w, inputs) {
    for (const p of bodies(w, "player")) {
      const inp = inputs[p.id];
      const sp = speedFor(p);
      p.vx = (inp?.dx ?? 0) * sp;
      p.vy = (inp?.dy ?? 0) * sp;
      moveBody(p, { bounds: arena });
    }
    botStep(w);
    magnetCheck(w);
    eatCheck(w);
    shapeCheck(w);
    shapeHuntCheck(w);
    botEatCheck(w);
    botFightCheck(w);
    blowbackCheck(w);
    while (bodies(w, "pellet").length < config.pellets) spawnPellet(w);
  },
};
