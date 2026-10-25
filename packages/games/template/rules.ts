// Agent-editable rules. Pure functions only. See guard script for banned APIs.
// Game: side-view tower climb, a 2D "Tower of Hell". Run, jump, shove rivals, reach the top first.
// No checkpoints: a missed jump drops you to whatever is below, a red kill brick sends you back to the ground.
// y grows downward: the ground surface is at config.floorY, the top platform is near y = 200 to 1200.
//
// Movement follows platformer conventions: fast ground acceleration, weaker air control, a fast rise
// with a short hang at the apex, a faster fall, variable height (letting go cuts the jump), coyote
// time and a jump buffer. The jump only fires on a fresh press, so holding the button never bunny-hops.
import { bodies, despawn, get, randomInt, randomRange, spawn, type Entity, type GameRules, type Input, type World } from "@tcg/shared";
import { config } from "./config.js";

export type PlatformType = "ground" | "top" | "ledge" | "moving" | "gap" | "beam" | "kill";

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
  best: number; // lowest y reached this round (score is height = floorY - best)
  wins: number;
  kick: number; // horizontal bump velocity, decays
  on: string; // id of the platform stood on, or ""
  last: string; // id of the platform stood on most recently (bots plan their next jump from it)
  held: boolean; // jump input held last tick (a jump needs a fresh press)
  jumping: boolean; // rising from a jump that can still be cut short
  coyote: number; // ticks left in which a jump still counts as from the ground
  buffer: number; // ticks left in which a pressed jump fires on landing
  deaths: number; // kill bricks touched this round
}

export interface BlastData {
  ticksLeft: number;
  fresh: boolean; // spawned this tick: damage not applied yet
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

/** The last safe platform of the path so far: the next section continues from it. */
export interface PathEnd {
  x: number;
  y: number;
  w: number;
  dir?: number; // -1 / 1: the way the path is heading
}

export interface SectionType {
  name: string;
  difficulty: number;
  build(w: World, from: PathEnd): PlatformSpec[];
}

const ROUND_ID = "round";
const W = config.towerWidth;

// --- jump envelope ---------------------------------------------------------------------------------

/** y offset (negative = up) after each tick of a jump with the button held all the way. */
export const JUMP_PATH: number[] = (() => {
  const out: number[] = [];
  let vy = -config.jumpSpeed;
  let y = 0;
  for (let t = 0; t < 60; t++) {
    vy = Math.min(vy + gravityFor(vy, true), config.maxFall);
    y += vy;
    out.push(y);
    if (y > 0) break;
  }
  return out;
})();

/** Highest point of a full jump, px above the take-off surface. */
export const MAX_RISE = -Math.min(...JUMP_PATH);

/** Ticks of a full jump until the player comes back down through a surface `rise` px above take-off (0 if never). */
export function airTicks(rise: number): number {
  let up = false;
  for (let t = 0; t < JUMP_PATH.length; t++) {
    if (-JUMP_PATH[t] >= rise) up = true;
    else if (up) return t;
  }
  return 0;
}

/** Widest edge-to-edge gap a perfect full-speed jump clears onto a platform `rise` px higher. */
export function maxGap(rise: number): number {
  return config.runSpeed * airTicks(rise);
}

function gravityFor(vy: number, held: boolean): number {
  if (held && Math.abs(vy) < config.apexSpeed) return config.gravityRise * config.apexGravityMult;
  return vy < 0 ? config.gravityRise : config.gravityFall;
}

// --- tower -----------------------------------------------------------------------------------------

/**
 * Next step of the path: `rise` px up and an edge gap of `gapShare` of what a full jump clears.
 * The path keeps its direction until it meets a wall, so it climbs in long diagonals across the tower.
 * Below a step there is no step of the same run to catch you: a missed jump falls down to the
 * diagonal before (or the ground), which costs a lot of height. That is the genre's tension.
 */
function nextStep(w: World, from: PathEnd, width: number, rise: number, gapShare: number): PathEnd {
  const gap = Math.max(4, maxGap(rise) * config.reachSafety * gapShare);
  const dist = (from.w + width) / 2 + gap;
  const lo = config.wallMargin + width / 2;
  const hi = W - config.wallMargin - width / 2;
  let dir = from.dir ?? (randomInt(w, 2) === 0 ? -1 : 1);
  if (from.x + dir * dist < lo || from.x + dir * dist > hi) dir = -dir;
  const x = Math.min(Math.max(from.x + dir * dist, lo), hi);
  return { x, y: from.y - rise, w: width, dir };
}

function rise(w: World, lo: number, hi: number): number {
  return Math.round(randomRange(w, lo, Math.min(hi, MAX_RISE * 0.9)));
}

/** A path of plain platforms of one width and type. */
function steps(w: World, from: PathEnd, type: PlatformType, width: number, riseLo: number, riseHi: number, gapLo: number, gapHi: number): PlatformSpec[] {
  const out: PlatformSpec[] = [];
  let at = from;
  for (let k = 0; k < config.stepsPerSection; k++) {
    at = nextStep(w, at, width, rise(w, riseLo, riseHi), randomRange(w, gapLo, gapHi));
    out.push({ x: at.x, y: at.y, w: width, type });
  }
  return out;
}

// Add your own section types here. Every safe platform must stay inside 0..towerWidth and be reachable
// from the one before it (nextStep keeps gaps within the jump envelope).
export const SECTION_TYPES: SectionType[] = [
  {
    name: "ledges",
    difficulty: 1,
    build: (w, from) => steps(w, from, "ledge", config.ledgeW, 45, 65, 0.3, 0.6),
  },
  {
    name: "moving",
    difficulty: 2,
    build(w, from) {
      const out: PlatformSpec[] = [];
      let at = from;
      for (let k = 0; k < config.stepsPerSection; k++) {
        const moving = k % 2 === 0;
        const width = moving ? config.ledgeW : config.gapW;
        at = nextStep(w, at, width, rise(w, 45, 60), randomRange(w, 0.3, 0.6));
        out.push(moving ? { x: at.x, y: at.y, w: width, type: "moving", range: config.movingRange } : { x: at.x, y: at.y, w: width, type: "gap" });
      }
      return out;
    },
  },
  {
    name: "gaps",
    difficulty: 3,
    build: (w, from) => steps(w, from, "gap", config.gapW, 50, 70, 0.6, 1),
  },
  {
    name: "beams",
    difficulty: 3,
    build: (w, from) => steps(w, from, "beam", config.beamW, 40, 60, 0.2, 0.6),
  },
  {
    name: "lava",
    difficulty: 4,
    build(w, from) {
      // Overshoot a ledge and you land in lava: a kill brick sits right behind every ledge.
      const out: PlatformSpec[] = [];
      let at = from;
      for (let k = 0; k < config.stepsPerSection; k++) {
        const prev = at;
        at = nextStep(w, at, config.gapW, rise(w, 45, 65), randomRange(w, 0.4, 0.8));
        out.push({ x: at.x, y: at.y, w: config.gapW, type: "ledge" });
        const dir = at.x >= prev.x ? 1 : -1;
        const kx = at.x + dir * (config.gapW / 2 + 10 + config.killW / 2);
        if (kx - config.killW / 2 >= 0 && kx + config.killW / 2 <= W) out.push({ x: kx, y: at.y, w: config.killW, type: "kill" });
      }
      return out;
    },
  },
];

/** Section types allowed at section `s`: the tower gets harder as it goes up. */
export function typesFor(s: number): SectionType[] {
  const maxDifficulty = 1 + Math.floor((s * 4) / config.sectionCount);
  return SECTION_TYPES.filter((t) => t.difficulty <= maxDifficulty);
}

function spawnPlatform(w: World, spec: PlatformSpec, h: number, section?: number): Entity<PlatformData> {
  const data: PlatformData = { w: spec.w, h, type: spec.type, ox: spec.x };
  if (section !== undefined) data.section = section;
  let x = spec.x;
  if (spec.type === "moving") {
    const range = Math.max(0, Math.min(spec.range ?? config.movingRange, spec.x - spec.w / 2, W - spec.x - spec.w / 2));
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

/** Builds the ground, sectionCount sections and the top platform. Returns the top platform's surface y. */
export function buildTower(w: World): number {
  spawnPlatform(w, { x: W / 2, y: config.floorY, w: W, type: "ground" }, config.groundH);
  // The ground is the whole width: the first jump may start anywhere.
  let at: PathEnd = { x: randomRange(w, W * 0.3, W * 0.7), y: config.floorY, w: W * 0.4 };
  for (let s = 0; s < config.sectionCount; s++) {
    const pool = typesFor(s);
    const type = pool[randomInt(w, pool.length)];
    for (const spec of type.build(w, at)) {
      spawnPlatform(w, spec, spec.type === "kill" ? config.killH : config.platformH, s);
      if (spec.type !== "kill") at = { x: spec.x, y: spec.y, w: spec.w, dir: spec.x >= at.x ? 1 : -1 };
    }
  }
  const top = nextStep(w, at, config.topW, rise(w, 45, 60), 0.4);
  spawnPlatform(w, { x: top.x, y: top.y, w: config.topW, type: "top" }, config.topH);
  return top.y;
}

// --- players ---------------------------------------------------------------------------------------

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

/** Back to the ground at a random spot. Keeps wins; `newRound` also clears this round's best and deaths. */
function toGround(w: World, p: Entity<PlayerData>, newRound: boolean): void {
  p.x = randomRange(w, config.playerR, W - config.playerR);
  p.y = config.floorY - config.playerR;
  p.vx = 0;
  p.vy = 0;
  p.r = config.playerR;
  p.ground = true;
  const d = p.data;
  if (newRound) { d.best = p.y; d.deaths = 0; }
  d.kick = 0;
  d.on = "";
  d.last = "";
  d.jumping = false;
  d.coyote = 0;
  d.buffer = 0;
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

function approach(v: number, target: number, step: number): number {
  return v < target ? Math.min(v + step, target) : Math.max(v - step, target);
}

/** One tick of movement. Returns the platform landed on, if any. */
function movePlayer(w: World, p: Entity<PlayerData>, dx: number, action: boolean): Entity<PlatformData> | null {
  const d = p.data;
  const R = p.r;
  const under = d.on ? get<PlatformData>(w, d.on) : undefined;
  if (under && under.data.type === "moving") p.x += under.data.dx ?? 0;
  const grounded = p.ground === true;

  // Run: target speed from the stick, reached fast on the ground and slower in the air.
  const dir = Math.max(-1, Math.min(1, dx));
  const accel = grounded ? (dir !== 0 ? config.groundAccel : config.groundDecel) : dir !== 0 ? config.airAccel : config.airDecel;
  p.vx = approach(p.vx, dir * config.runSpeed, accel);

  // Jump: fresh press -> buffer; ground (or coyote time) + buffer -> jump.
  const pressed = action && !d.held;
  d.held = action;
  if (pressed) d.buffer = config.jumpBufferTicks + 1;
  if (grounded) d.coyote = config.coyoteTicks + 1;
  if (d.buffer > 0 && d.coyote > 0) {
    p.vy = -config.jumpSpeed;
    d.jumping = true;
    d.buffer = 0;
    d.coyote = 0;
    if (randomInt(w, config.blastOdds) === 0) {
      spawn<BlastData>(w, { kind: "blast", x: p.x, y: p.y, r: config.blastRadius, data: { ticksLeft: config.blastTicks, fresh: true } });
    }
  }
  if (d.buffer > 0) d.buffer--;
  if (d.coyote > 0) d.coyote--;
  if (d.jumping && (!action || p.vy >= 0)) {
    if (p.vy < -config.jumpCutSpeed) p.vy = -config.jumpCutSpeed;
    d.jumping = false;
  }

  p.vy = Math.min(p.vy + gravityFor(p.vy, action), config.maxFall);
  p.x = Math.min(Math.max(p.x + p.vx + d.kick, R), W - R);
  if ((p.x <= R && p.vx < 0) || (p.x >= W - R && p.vx > 0)) p.vx = 0;
  d.kick = Math.abs(d.kick) < 0.1 ? 0 : d.kick * 0.6;

  const prevBottom = p.y + R;
  p.y += p.vy;
  p.ground = false;
  d.on = "";
  let landed: Entity<PlatformData> | null = null;
  if (p.vy >= 0) {
    const bottom = p.y + R;
    for (const pl of bodies<PlatformData>(w, "platform")) {
      if (pl.data.type === "kill") continue;
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
      d.last = landed.id;
      d.jumping = false;
    }
  }
  if (p.y < d.best) d.best = p.y;
  return landed;
}

/** Touching a kill brick (with a slightly forgiving hitbox) sends the player back to the ground. */
function touchesKill(w: World, p: Entity<PlayerData>): boolean {
  const r = p.r * 0.8;
  for (const k of bodies<PlatformData>(w, "platform")) {
    if (k.data.type !== "kill") continue;
    const cx = Math.max(k.x - k.data.w / 2, Math.min(p.x, k.x + k.data.w / 2));
    const cy = Math.max(k.y - k.data.h / 2, Math.min(p.y, k.y + k.data.h / 2));
    if ((p.x - cx) ** 2 + (p.y - cy) ** 2 < r * r) return true;
  }
  return false;
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
      a.x = Math.min(Math.max(a.x - dir * push, R), W - R);
      b.x = Math.min(Math.max(b.x + dir * push, R), W - R);
      a.data.kick = -dir * config.bumpPush;
      b.data.kick = dir * config.bumpPush;
    }
  }
}

/** Ages existing blasts and removes the expired ones. */
function ageBlasts(w: World): void {
  for (const b of bodies<BlastData>(w, "blast")) {
    if (--b.data.ticksLeft <= 0) despawn(w, b.id);
  }
}

/** Fresh blasts hit every player whose centre is in range: knocked away and slammed down. Same for everyone. */
function applyBlasts(w: World, players: Entity<PlayerData>[]): void {
  for (const b of bodies<BlastData>(w, "blast")) {
    if (!b.data.fresh) continue;
    b.data.fresh = false;
    for (const p of players) {
      const dx = p.x - b.x;
      const dy = p.y - b.y;
      if (dx * dx + dy * dy > b.r * b.r) continue;
      p.data.kick = (dx < 0 ? -1 : 1) * config.blastKick;
      p.vy = config.blastSlam;
      p.data.jumping = false;
      p.ground = false;
      p.data.on = "";
    }
  }
}

function startRound(w: World, r: Entity<RoundData>): void {
  for (const b of bodies(w, "blast")) despawn(w, b.id);
  for (const p of bodies(w, "platform")) despawn(w, p.id);
  r.data.topY = buildTower(w);
  for (const p of bodies<PlayerData>(w, "player")) toGround(w, p, true);
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

const jumpInput = (inp: Input | undefined) => (inp?.action ?? false) || (inp?.dy ?? 0) < -0.5;

// --- bots ------------------------------------------------------------------------------------------

/** The platform a climber standing on `from` should jump to next: reachable, above, horizontally closest. */
export function nextTarget(w: World, from: Entity<PlatformData>): Entity<PlatformData> | null {
  const base = platformTop(from);
  let best: Entity<PlatformData> | null = null;
  let bestCost = Infinity;
  for (const pl of bodies<PlatformData>(w, "platform")) {
    if (pl === from || pl.data.type === "kill" || pl.data.type === "ground") continue;
    const rise = base - platformTop(pl);
    if (rise < 15 || rise > MAX_RISE - 4) continue;
    const gap = Math.abs(pl.x - from.x) - (pl.data.w + from.data.w) / 2;
    if (gap > maxGap(rise)) continue;
    const cost = Math.abs(pl.x - from.x) - rise * 2;
    if (cost < bestCost) { bestCost = cost; best = pl; }
  }
  return best;
}

const BOT_MISS_PERCENT = 30;
const BOT_STICK = 0.9;

/** A climbing bot: runs toward the next platform up and jumps near the edge. Makes timing mistakes now and then. */
function botInput(w: World, id: string, n: number): Input {
  const idle: Input = { dx: 0, dy: 0, action: false };
  const me = get<PlayerData>(w, id);
  const r = get<RoundData>(w, ROUND_ID);
  if (!me || !r || r.data.phase !== "play") return idle;
  const d = me.data;
  const lastPl = d.last ? get<PlatformData>(w, d.last) : undefined;
  // Back on the floor (fell, or killed) counts as never having climbed: `last` is stale then.
  const onFloor = me.y >= config.floorY - config.playerR - 1;
  const from = onFloor || lastPl?.data.type === "ground" ? undefined : lastPl;
  if (!from) {
    // On the ground (or never landed yet): go to the lowest platform's foot and jump.
    let first: Entity<PlatformData> | null = null;
    for (const pl of bodies<PlatformData>(w, "platform")) {
      if (pl.data.type === "ground" || pl.data.type === "kill") continue;
      if (!first || platformTop(pl) > platformTop(first)) first = pl;
    }
    if (!first) return idle;
    const dx = first.x - me.x;
    const jump = me.ground === true && !d.held && Math.abs(dx) < first.data.w / 2 + 30;
    return { dx: Math.abs(dx) > 3 ? Math.sign(dx) : 0, dy: 0, action: jump || (d.jumping && me.vy < 0) };
  }
  const target = nextTarget(w, from);
  if (!target) return idle;
  const dx = target.x - me.x;
  // Bots are fillers, not rivals: about a third of their jumps from a platform are botched.
  const roundNo = r.data.round;
  let h = n * 2654435761 + roundNo * 40503 + Math.floor(w.tick / 45) * 97; // changes every 3 s: no bot is stuck botching one jump
  for (let i = 0; i < from.id.length; i++) h = (Math.imul(h, 31) + from.id.charCodeAt(i)) >>> 0;
  const botched = h % 100 < BOT_MISS_PERCENT;
  if (me.ground !== true) {
    // In the air: steer onto the target and hold the jump while rising. A botched jump lets go of
    // the stick at the apex and drops short.
    if (botched && me.vy > 0) return { dx: 0, dy: 0, action: false };
    return { dx: Math.abs(dx) > 4 ? Math.sign(dx) * BOT_STICK : 0, dy: 0, action: d.jumping && me.vy < 0 };
  }
  // On a platform: run toward the target; jump once close enough. The lead varies by bot and step, so bots sometimes miss.
  const rise = platformTop(from) - platformTop(target);
  const reach = config.runSpeed * airTicks(rise) * 0.6;
  const wobble = ((n * 7 + w.tick) % 13) / 13; // 0..1, deterministic
  const lead = reach * (botched ? 2.2 : 0.75 + 0.6 * wobble); // a botched jump also takes off far too early
  // About to run off the edge toward the target: jump now (the classic edge jump).
  const nx = me.x + me.vx + Math.sign(dx) * config.groundAccel;
  const atEdge = Math.abs(nx - from.x) > from.data.w / 2 - 1 && Math.sign(dx) === Math.sign(nx - from.x);
  // Bots hesitate before each jump (about 1.5 s on average), like a player lining up.
  if (!atEdge && (w.tick + h) % 40 >= 9) return { dx: 0, dy: 0, action: false };
  const jump = !d.held && (Math.abs(dx) <= lead || atEdge);
  return { dx: Math.abs(dx) > 3 ? Math.sign(dx) * BOT_STICK : 0, dy: 0, action: jump };
}

// --- rules -----------------------------------------------------------------------------------------

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
      data: { best: 0, wins: 0, kick: 0, on: "", last: "", held: false, jumping: false, coyote: 0, buffer: 0, deaths: 0 },
    });
    toGround(w, p, true);
  },
  bot: botInput,
  step(w, inputs) {
    const r = round(w);
    const players = bodies<PlayerData>(w, "player");
    if (r.data.phase === "results") {
      for (const p of players) { p.vx = 0; p.vy = 0; }
      if (--r.data.ticksLeft <= 0) startRound(w, r);
      return;
    }
    movePlatforms(w);
    ageBlasts(w);
    let winner: Entity<PlayerData> | null = null;
    for (const p of players) {
      const inp = inputs[p.id];
      const landed = movePlayer(w, p, inp?.dx ?? 0, jumpInput(inp));
      if (touchesKill(w, p)) {
        p.data.deaths++;
        toGround(w, p, false);
        continue;
      }
      if (landed && landed.data.type === "top" && !winner) winner = p;
    }
    applyBlasts(w, players);
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
