// Agent-editable rules. Pure functions only. See guard script for banned APIs.
// Game: side-view tower climb. Run, jump, shove rivals, reach the top platform first.
// y grows downward: the ground surface is at config.floorY, the top of the tower is near y=150.
import { bodies, despawn, get, randomInt, randomRange, spawn, type Entity, type GameRules, type World } from "@tcg/shared";
import { config } from "./config.js";

export type PlatformType = "ground" | "top" | "ledge" | "moving" | "gap" | "beam";

export interface PlatformData {
  w: number;
  h: number;
  type: PlatformType;
  ox: number; // home x (centre of oscillation for moving platforms)
  range?: number;
  dir?: number;
  dx?: number; // x movement this tick (carries riders)
  section?: number;
}

export interface PlayerData {
  best: number; // lowest y reached (score is height = floorY - best)
  wins: number;
  jumpTicks: number; // ticks of jump-hold boost still available
  kick: number; // horizontal bump velocity, decays
  on: string; // id of the platform stood on, or ""
}

export interface RoundData {
  phase: "play" | "results";
  ticksLeft: number;
  winner: string;
  topY: number;
  round: number;
}

export interface PlatformSpec {
  x: number;
  y: number; // surface (top) y
  w: number;
  type: PlatformType;
  range?: number;
}

export interface SectionType {
  name: string;
  difficulty: number;
  build(w: World, baseY: number): PlatformSpec[];
}

export const STEPS_PER_SECTION = 4;
const CX = config.towerWidth / 2;
const ROUND_ID = "round";

function step(): number {
  return config.sectionHeight / STEPS_PER_SECTION;
}

// Every section ends with a static anchor ledge at its top (y = baseY - sectionHeight), near the tower centre.
function anchor(w: World, baseY: number): PlatformSpec {
  return { x: CX + randomRange(w, -60, 60), y: baseY - config.sectionHeight, w: config.ledgeW, type: "ledge" };
}

// Add your own section types here. Every platform must stay inside 0..towerWidth and be reachable by the jump physics.
export const SECTION_TYPES: SectionType[] = [
  {
    name: "ledges",
    difficulty: 1,
    build(w, baseY) {
      const out: PlatformSpec[] = [];
      let side = randomInt(w, 2) === 0 ? -1 : 1;
      for (let k = 1; k < STEPS_PER_SECTION; k++) {
        out.push({ x: CX + side * 80 + randomRange(w, -15, 15), y: baseY - k * step(), w: config.ledgeW, type: "ledge" });
        side = -side;
      }
      out.push(anchor(w, baseY));
      return out;
    },
  },
  {
    name: "moving",
    difficulty: 2,
    build(w, baseY) {
      const range = 120;
      return [
        { x: CX, y: baseY - step(), w: 100, type: "moving", range },
        { x: CX + randomRange(w, -50, 50), y: baseY - 2 * step(), w: config.ledgeW, type: "ledge" },
        { x: CX, y: baseY - 3 * step(), w: 100, type: "moving", range },
        anchor(w, baseY),
      ];
    },
  },
  {
    name: "gap",
    difficulty: 3,
    build(w, baseY) {
      const out: PlatformSpec[] = [];
      let side = randomInt(w, 2) === 0 ? -1 : 1;
      for (let k = 1; k < STEPS_PER_SECTION; k++) {
        out.push({ x: CX + side * 75 + randomRange(w, -5, 5), y: baseY - k * step(), w: 90, type: "gap" });
        side = -side;
      }
      out.push(anchor(w, baseY));
      return out;
    },
  },
  {
    name: "beam",
    difficulty: 4,
    build(w, baseY) {
      const out: PlatformSpec[] = [];
      let x = CX + randomRange(w, -60, 60);
      for (let k = 1; k < STEPS_PER_SECTION; k++) {
        out.push({ x, y: baseY - k * step(), w: config.beamW, type: "beam" });
        x = Math.min(Math.max(x + randomRange(w, -90, 90), CX - 110), CX + 110);
      }
      out.push(anchor(w, baseY));
      return out;
    },
  },
];

function spawnPlatform(w: World, spec: PlatformSpec, h: number, section?: number): Entity<PlatformData> {
  const data: PlatformData = { w: spec.w, h, type: spec.type, ox: spec.x };
  if (section !== undefined) data.section = section;
  let x = spec.x;
  if (spec.type === "moving") {
    const range = spec.range ?? 100;
    data.range = range;
    data.dir = randomInt(w, 2) === 0 ? -1 : 1;
    x = spec.x + randomRange(w, -range, range);
    data.dx = 0;
  }
  return spawn<PlatformData>(w, { kind: "platform", x, y: spec.y + h / 2, r: Math.min(spec.w / 2, 100), data });
}

export function platformTop(p: Entity<PlatformData>): number {
  return p.y - p.data.h / 2;
}

export const COIN_R = 2;
export const COINS_PER_SECTION = 2;
export const COIN_GROW = 0.25;
export const PLAYER_MAX_R = config.playerR * 1.6;

function spawnCoin(w: World, x: number, y: number): void {
  spawn(w, { kind: "pellet", x, y, r: COIN_R, data: {} });
}

export function buildTower(w: World): number {
  spawnPlatform(w, { x: CX, y: config.floorY, w: config.towerWidth, type: "ground" }, config.groundH);
  // A row of coins along the ground near the spawn point.
  for (let x = 30; x <= config.towerWidth - 30; x += 20) spawnCoin(w, x, config.floorY - 2.4 * config.playerR);
  for (let s = 0; s < config.sectionCount; s++) {
    const baseY = config.floorY - s * config.sectionHeight;
    const type = SECTION_TYPES[randomInt(w, SECTION_TYPES.length)];
    const specs = type.build(w, baseY);
    for (const spec of specs) spawnPlatform(w, spec, config.platformH, s);
    // Coins glow above static ledges (moving platforms would leave them behind).
    const fixed = specs.filter((sp) => sp.type !== "moving");
    for (let c = 0; c < COINS_PER_SECTION && fixed.length > 0; c++) {
      const sp = fixed[randomInt(w, fixed.length)];
      spawnCoin(w, sp.x + randomRange(w, -sp.w / 3, sp.w / 3), sp.y - config.playerR);
    }
  }
  const topY = config.floorY - config.sectionCount * config.sectionHeight - step();
  spawnPlatform(w, { x: CX, y: topY, w: 200, type: "top" }, config.topH);
  return topY;
}

function round(w: World): Entity<RoundData> {
  let r = get<RoundData>(w, ROUND_ID);
  if (!r) {
    const topY = buildTower(w);
    r = spawn<RoundData>(w, {
      id: ROUND_ID,
      kind: "round",
      x: 0,
      y: 0,
      r: 1,
      data: { phase: "play", ticksLeft: config.roundSeconds * config.tickHz, winner: "", topY, round: 1 },
    });
  }
  return r;
}

function resetPlayer(w: World, p: Entity<PlayerData>): void {
  p.x = randomRange(w, config.playerR, config.towerWidth - config.playerR);
  p.y = config.floorY - config.playerR;
  p.vx = 0;
  p.vy = 0;
  p.r = config.playerR;
  p.ground = true;
  p.data.best = p.y;
  p.data.jumpTicks = 0;
  p.data.kick = 0;
  p.data.on = "";
}

function movePlatforms(w: World): void {
  for (const p of bodies<PlatformData>(w, "platform")) {
    if (p.data.type !== "moving") continue;
    const range = p.data.range ?? 0;
    const before = p.x;
    p.x += (p.data.dir ?? 1) * config.movingPlatformSpeed;
    if (p.x >= p.data.ox + range) { p.x = p.data.ox + range; p.data.dir = -1; }
    else if (p.x <= p.data.ox - range) { p.x = p.data.ox - range; p.data.dir = 1; }
    p.data.dx = p.x - before;
  }
}

// Returns the platform the player landed on this tick, if any.
function movePlayer(w: World, p: Entity<PlayerData>, dx: number, action: boolean): Entity<PlatformData> | null {
  const d = p.data;
  const R = p.r;
  const under = d.on ? get<PlatformData>(w, d.on) : undefined;
  const wasGrounded = p.ground === true;
  if (under && under.data.type === "moving") p.x += under.data.dx ?? 0;

  if (wasGrounded && action) {
    p.vy = -config.jumpSpeed;
    d.jumpTicks = config.jumpHoldTicks;
  } else if (d.jumpTicks > 0) {
    if (action && p.vy < 0) {
      p.vy -= config.jumpHoldBoost / config.jumpHoldTicks;
      d.jumpTicks--;
    } else d.jumpTicks = 0;
  }

  p.vy = Math.min(p.vy + config.gravity, config.maxFall);
  p.vx = Math.max(-1, Math.min(1, dx)) * config.runSpeed + d.kick;
  d.kick = Math.abs(d.kick) < 0.1 ? 0 : d.kick * 0.6;
  p.x = Math.min(Math.max(p.x + p.vx, R), config.towerWidth - R);

  const prevBottom = p.y + R;
  p.y += p.vy;
  p.ground = false;
  d.on = "";
  let landed: Entity<PlatformData> | null = null;
  if (p.vy >= 0) {
    const bottom = p.y + R;
    for (const pl of bodies<PlatformData>(w, "platform")) {
      const top = platformTop(pl);
      if (top < prevBottom - 0.01 || top > bottom) continue;
      if (Math.abs(p.x - pl.x) > pl.data.w / 2) continue;
      if (!landed || top < platformTop(landed)) landed = pl;
    }
    if (landed) {
      p.y = platformTop(landed) - R;
      p.vy = 0;
      p.ground = true;
      d.on = landed.id;
      d.jumpTicks = 0;
    }
  }
  if (p.y < d.best) d.best = p.y;
  return landed;
}

// A player touching a coin collects it and grows a little, up to PLAYER_MAX_R.
function collectCoins(w: World, p: Entity<PlayerData>): void {
  for (const c of bodies(w, "pellet")) {
    if ((c.x - p.x) ** 2 + (c.y - p.y) ** 2 > (p.r + c.r) ** 2) continue;
    despawn(w, c.id);
    p.r = Math.min(p.r + COIN_GROW, PLAYER_MAX_R);
  }
}

// Overlapping players are pushed apart sideways and kicked away from each other.
function bumpPlayers(players: Entity<PlayerData>[]): void {
  const R = config.playerR;
  for (let i = 0; i < players.length; i++) {
    for (let j = i + 1; j < players.length; j++) {
      const a = players[i];
      const b = players[j];
      const ddx = b.x - a.x;
      const ddy = b.y - a.y;
      if (ddx * ddx + ddy * ddy >= (2 * R) ** 2) continue;
      const dir = ddx > 0 ? 1 : ddx < 0 ? -1 : 1;
      const push = (2 * R - Math.abs(ddx)) / 2;
      a.x = Math.min(Math.max(a.x - dir * push, R), config.towerWidth - R);
      b.x = Math.min(Math.max(b.x + dir * push, R), config.towerWidth - R);
      a.data.kick = -dir * config.bumpPush;
      b.data.kick = dir * config.bumpPush;
    }
  }
}

function startRound(w: World, r: Entity<RoundData>): void {
  for (const p of bodies(w, "platform")) despawn(w, p.id);
  for (const c of bodies(w, "pellet")) despawn(w, c.id);
  r.data.topY = buildTower(w);
  for (const p of bodies<PlayerData>(w, "player")) resetPlayer(w, p);
  r.data.phase = "play";
  r.data.ticksLeft = config.roundSeconds * config.tickHz;
  r.data.winner = "";
  r.data.round++;
}

function endRound(r: Entity<RoundData>, winner: Entity<PlayerData> | null): void {
  if (winner) {
    r.data.winner = winner.id;
    winner.data.wins++;
  }
  r.data.phase = "results";
  r.data.ticksLeft = config.resultsSeconds * config.tickHz;
}

export const rules: GameRules = {
  arena: { w: config.towerWidth, h: config.towerHeight },
  init(w) {
    round(w);
  },
  join(w, playerId) {
    round(w);
    const p = spawn<PlayerData>(w, {
      id: playerId,
      kind: "player",
      r: config.playerR,
      data: { best: 0, wins: 0, jumpTicks: 0, kick: 0, on: "" },
    });
    resetPlayer(w, p);
  },
  step(w, inputs) {
    const r = round(w);
    const players = bodies<PlayerData>(w, "player");
    if (r.data.phase === "results") {
      for (const p of players) { p.vx = 0; p.vy = 0; }
      if (--r.data.ticksLeft <= 0) startRound(w, r);
      return;
    }
    movePlatforms(w);
    let winner: Entity<PlayerData> | null = null;
    for (const p of players) {
      const inp = inputs[p.id];
      const landed = movePlayer(w, p, inp?.dx ?? 0, inp?.action ?? false);
      collectCoins(w, p);
      if (landed && landed.data.type === "top" && !winner) winner = p;
    }
    bumpPlayers(players);
    r.data.ticksLeft--;
    if (!winner && r.data.ticksLeft <= 0) {
      const start = config.floorY - config.playerR;
      for (const p of players) {
        if (p.data.best < start - 1 && (!winner || p.data.best < winner.data.best)) winner = p;
      }
      endRound(r, winner);
    } else if (winner) endRound(r, winner);
  },
};
