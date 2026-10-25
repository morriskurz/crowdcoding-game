// Agent-editable rules. Pure functions only. See guard script for banned APIs.
// Game: side-view tower climb, a 2D "Tower of Hell". Run, jump, shove rivals, reach the top first.
// No checkpoints: a missed jump drops you to whatever is below; lava and spinning bars send you back to the ground.
// y grows downward: the ground surface is at config.floorY, the top platform is a few hundred px from the top.
//
// Movement follows platformer conventions: fast ground acceleration, weaker air control, a fast rise
// with a short hang at the apex, a faster fall, variable height (letting go cuts the jump), coyote
// time and a jump buffer. The jump only fires on a fresh press, so holding the button never bunny-hops.
// The stick is digital past a small dead zone: a half-pushed joystick runs at full speed.
import { bodies, despawn, get, randomInt, randomRange, spawn, type Entity, type GameRules, type Input, type World } from "@tcg/shared";
import { config } from "./config.js";

export type PlatformType =
  | "ground" | "top" | "ledge" | "moving" | "gap" | "beam" | "ice" | "crumble" | "blink" // stand on these
  | "kill" | "spinner"; // touch these and you are back on the ground

export interface PlatformData {
  w: number;
  h: number;
  type: PlatformType;
  ox: number; // home x (centre of oscillation for moving platforms)
  range?: number;
  dir?: number;
  dx?: number; // x movement this tick (carries riders)
  section?: number;
  phase?: number; // blink: tick offset of the on/off cycle
  solid?: boolean; // blink / crumble: can be stood on right now
  warn?: boolean; // blink / crumble: about to vanish
  fuse?: number; // crumble: ticks until it drops (counts once someone stands on it)
  down?: number; // crumble: ticks until it is back
  a?: number; // spinner: bar angle (radians)
  spin?: number; // spinner: radians per tick
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
  deaths: number; // lava / spinner touches this round
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
  y: number; // surface (top) y; a spinner's pivot
  w: number; // a spinner: 2 x bar length
  type: PlatformType;
  range?: number;
  phase?: number;
}

/** The last safe platform of the path so far: the next step continues from it. */
export interface PathEnd {
  x: number;
  y: number;
  w: number;
  dir?: number; // -1 / 1: the way the path is heading
}

/** One kind of step: the safe platform to land on next, plus any hazards around it. The first spec is the safe one. */
export interface StepType {
  name: string;
  difficulty: number;
  step(w: World, from: PathEnd, k: number): PlatformSpec[];
}

const ROUND_ID = "round";
const W = config.towerWidth;
const HAZARDS: ReadonlySet<PlatformType> = new Set(["kill", "spinner"]);
export const isHazard = (t: PlatformType) => HAZARDS.has(t);

// --- jump envelope ---------------------------------------------------------------------------------

function gravityFor(vy: number, held: boolean): number {
  if (held && Math.abs(vy) < config.apexSpeed) return config.gravityRise * config.apexGravityMult;
  return vy < 0 ? config.gravityRise : config.gravityFall;
}

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

/** A rise between `lo` and `hi` shares of the highest jump (never above 85 % of it). */
function rise(w: World, lo: number, hi: number): number {
  return Math.round(randomRange(w, lo, Math.min(hi, 0.85)) * MAX_RISE);
}

/** A plain step onto a platform of this type and width. */
function plain(type: PlatformType, width: (w: World) => number, riseLo: number, riseHi: number, gapLo: number, gapHi: number) {
  return (w: World, from: PathEnd): PlatformSpec[] => {
    const wd = Math.round(width(w));
    const at = nextStep(w, from, wd, rise(w, riseLo, riseHi), randomRange(w, gapLo, gapHi));
    return [{ x: at.x, y: at.y, w: wd, type }];
  };
}

// Add your own step types here. The first spec of a step is the platform to land on; it must stay inside
// 0..towerWidth and be reachable from the one before (nextStep keeps gaps within the jump envelope).
export const STEP_TYPES: StepType[] = [
  { name: "ledges", difficulty: 1, step: plain("ledge", (w) => randomRange(w, 70, config.ledgeW), 0.5, 0.75, 0.3, 0.6) },
  {
    name: "moving",
    difficulty: 2,
    step(w, from, k) {
      if (k % 2 === 1) return plain("gap", () => config.gapW, 0.5, 0.7, 0.3, 0.6)(w, from);
      const at = nextStep(w, from, 80, rise(w, 0.5, 0.7), randomRange(w, 0.3, 0.6));
      return [{ x: at.x, y: at.y, w: 80, type: "moving", range: config.movingRange }];
    },
  },
  // Ice: you keep sliding after you let go, so a narrow icy ledge is easy to slide off.
  { name: "ice", difficulty: 2, step: plain("ice", () => config.ledgeW, 0.5, 0.7, 0.3, 0.6) },
  // Crumbling: drops a moment after someone lands on it, comes back a few seconds later.
  { name: "crumble", difficulty: 2, step: plain("crumble", () => 70, 0.5, 0.75, 0.3, 0.6) },
  { name: "gaps", difficulty: 3, step: plain("gap", () => config.gapW, 0.55, 0.8, 0.6, 1) },
  { name: "beams", difficulty: 3, step: plain("beam", () => config.beamW, 0.5, 0.7, 0.2, 0.6) },
  {
    // Blinking: on and off in turn, neighbours out of phase, so you wait for your moment.
    name: "blink",
    difficulty: 3,
    step(w, from, k) {
      const at = nextStep(w, from, 70, rise(w, 0.5, 0.7), randomRange(w, 0.3, 0.6));
      return [{ x: at.x, y: at.y, w: 70, type: "blink", phase: (k % 2) * Math.round(config.blinkPeriod / 2) }];
    },
  },
  {
    // Overshoot a ledge and you land in lava: a kill brick sits right behind it.
    name: "lava",
    difficulty: 4,
    step(w, from) {
      const at = nextStep(w, from, config.gapW, rise(w, 0.5, 0.8), randomRange(w, 0.4, 0.8));
      const out: PlatformSpec[] = [{ x: at.x, y: at.y, w: config.gapW, type: "ledge" }];
      const dir = at.x >= from.x ? 1 : -1;
      const off = config.gapW / 2 + 10 + config.killW / 2;
      const fits = (kx: number) => kx - config.killW / 2 >= 0 && kx + config.killW / 2 <= W;
      // No room behind it (wall): the lava goes in front, so an undershoot burns instead.
      const kx = fits(at.x + dir * off) ? at.x + dir * off : at.x - dir * off;
      if (fits(kx)) out.push({ x: kx, y: at.y, w: config.killW, type: "kill" });
      return out;
    },
  },
  {
    // A lava bar turns like a windmill above a ledge: land and leave while it points away.
    name: "spinner",
    difficulty: 4,
    step(w, from) {
      const at = nextStep(w, from, config.ledgeW, rise(w, 0.5, 0.7), randomRange(w, 0.3, 0.6));
      return [
        { x: at.x, y: at.y, w: config.ledgeW, type: "ledge" },
        { x: at.x, y: at.y - config.spinnerLift, w: 2 * config.spinnerLen, type: "spinner" },
      ];
    },
  },
];

/** Step types allowed in section `s`: the tower gets harder as it goes up. */
export function typesFor(s: number): StepType[] {
  const maxDifficulty = 1 + Math.floor((s * 4) / config.sectionCount);
  return STEP_TYPES.filter((t) => t.difficulty <= maxDifficulty);
}

function spawnPlatform(w: World, spec: PlatformSpec, section?: number): Entity<PlatformData> {
  const h = spec.type === "ground" ? config.groundH : spec.type === "top" ? config.topH : spec.type === "kill" ? config.killH : spec.type === "spinner" ? 8 : config.platformH;
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
  if (spec.type === "blink") { data.phase = spec.phase ?? 0; data.solid = true; data.warn = false; }
  if (spec.type === "crumble") { data.fuse = 0; data.down = 0; data.solid = true; data.warn = false; }
  if (spec.type === "spinner") {
    data.a = randomRange(w, 0, Math.PI * 2);
    data.spin = (randomInt(w, 2) === 0 ? -1 : 1) * config.spinnerSpeed;
    return spawn<PlatformData>(w, { kind: "platform", x, y: spec.y, r: spec.w / 2, data });
  }
  return spawn<PlatformData>(w, { kind: "platform", x, y: spec.y + h / 2, r: Math.min(spec.w / 2, 100), data });
}

export function platformTop(p: Entity<PlatformData>): number {
  return p.y - p.data.h / 2;
}

/** Can be stood on right now (blinking and crumbling platforms come and go; hazards never). */
export function solid(p: Entity<PlatformData>): boolean {
  return !isHazard(p.data.type) && p.data.solid !== false;
}

/**
 * Builds the ground, sectionCount sections and the top platform. Returns the top platform's surface y.
 * Each section alternates two step types from its difficulty pool (one type in the first sections).
 */
export function buildTower(w: World): number {
  spawnPlatform(w, { x: W / 2, y: config.floorY, w: W, type: "ground" });
  // The ground is the whole width: the first jump may start anywhere.
  let at: PathEnd = { x: randomRange(w, W * 0.3, W * 0.7), y: config.floorY, w: W * 0.4 };
  for (let s = 0; s < config.sectionCount; s++) {
    const pool = typesFor(s);
    const a = pool[randomInt(w, pool.length)];
    const b = s < 2 ? a : pool[randomInt(w, pool.length)];
    for (let k = 0; k < config.stepsPerSection; k++) {
      const specs = (k % 2 === 0 ? a : b).step(w, at, k);
      for (const spec of specs) spawnPlatform(w, spec, s);
      const safe = specs[0];
      at = { x: safe.x, y: safe.y, w: safe.w, dir: safe.x >= at.x ? 1 : -1 };
    }
  }
  const top = nextStep(w, at, config.topW, rise(w, 0.5, 0.7), 0.4);
  spawnPlatform(w, { x: top.x, y: top.y, w: config.topW, type: "top" });
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

/** Moving platforms move, blinking ones switch, crumbling ones count down, spinners turn. */
function updatePlatforms(w: World): void {
  for (const p of bodies<PlatformData>(w, "platform")) {
    const d = p.data;
    if (d.type === "moving") {
      const range = d.range ?? 0;
      const before = p.x;
      p.x += (d.dir ?? 1) * config.movingPlatformSpeed;
      if (p.x >= d.ox + range) { p.x = d.ox + range; d.dir = -1; }
      else if (p.x <= d.ox - range) { p.x = d.ox - range; d.dir = 1; }
      d.dx = p.x - before;
    } else if (d.type === "blink") {
      const t = (w.tick + (d.phase ?? 0)) % config.blinkPeriod;
      d.solid = t < config.blinkOn;
      d.warn = d.solid && t >= config.blinkOn - config.warnTicks;
    } else if (d.type === "crumble") {
      if ((d.fuse ?? 0) > 0 && --d.fuse! === 0) d.down = config.crumbleDown;
      else if ((d.down ?? 0) > 0) d.down!--;
      d.solid = (d.down ?? 0) === 0;
      d.warn = (d.fuse ?? 0) > 0;
    } else if (d.type === "spinner") {
      d.a = ((d.a ?? 0) + (d.spin ?? 0) + Math.PI * 2) % (Math.PI * 2);
    }
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
  const grounded = p.ground === true && (!under || solid(under));
  const icy = grounded && under?.data.type === "ice";

  // Run: past the dead zone the stick is full speed (a platformer, not an analog racer).
  const dir = Math.abs(dx) > config.stickDeadZone ? Math.sign(dx) : 0;
  const accel = icy
    ? (dir !== 0 ? config.iceAccel : config.iceDecel)
    : grounded ? (dir !== 0 ? config.groundAccel : config.groundDecel) : dir !== 0 ? config.airAccel : config.airDecel;
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
      if (!solid(pl)) continue;
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
      if (landed.data.type === "crumble" && !landed.data.fuse) landed.data.fuse = config.crumbleFuse;
    }
  }
  if (p.y < d.best) d.best = p.y;
  return landed;
}

/** Touching lava or a spinning bar (with a slightly forgiving hitbox) sends the player back to the ground. */
function touchesHazard(w: World, p: Entity<PlayerData>): boolean {
  const r = p.r * 0.8;
  for (const k of bodies<PlatformData>(w, "platform")) {
    if (k.data.type === "kill") {
      const cx = Math.max(k.x - k.data.w / 2, Math.min(p.x, k.x + k.data.w / 2));
      const cy = Math.max(k.y - k.data.h / 2, Math.min(p.y, k.y + k.data.h / 2));
      if ((p.x - cx) ** 2 + (p.y - cy) ** 2 < r * r) return true;
    } else if (k.data.type === "spinner") {
      // The bar runs through the pivot: distance from the player to that segment.
      const half = k.data.w / 2;
      const ux = Math.cos(k.data.a ?? 0), uy = Math.sin(k.data.a ?? 0);
      const t = Math.max(-half, Math.min(half, (p.x - k.x) * ux + (p.y - k.y) * uy));
      const reach = r + k.data.h / 2;
      if ((p.x - (k.x + ux * t)) ** 2 + (p.y - (k.y + uy * t)) ** 2 < reach * reach) return true;
    }
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

function startRound(w: World, r: Entity<RoundData>): void {
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

/** The platform a climber standing on `from` should jump to next: reachable, standable now, above, horizontally closest. */
export function nextTarget(w: World, from: Entity<PlatformData>): Entity<PlatformData> | null {
  const base = platformTop(from);
  let best: Entity<PlatformData> | null = null;
  let bestCost = Infinity;
  for (const pl of bodies<PlatformData>(w, "platform")) {
    if (pl === from || isHazard(pl.data.type) || pl.data.type === "ground") continue;
    const rise = base - platformTop(pl);
    if (rise < 10 || rise > MAX_RISE - 3) continue;
    const gap = Math.abs(pl.x - from.x) - (pl.data.w + from.data.w) / 2;
    if (gap > maxGap(rise)) continue;
    const cost = Math.abs(pl.x - from.x) - rise * 2;
    if (cost < bestCost) { bestCost = cost; best = pl; }
  }
  return best;
}

const BOT_MISS_PERCENT = 30;

/** A climbing bot: runs toward the next platform up and jumps near the edge. Makes timing mistakes now and then. */
function botInput(w: World, id: string, n: number): Input {
  const idle: Input = { dx: 0, dy: 0, action: false };
  const me = get<PlayerData>(w, id);
  const r = get<RoundData>(w, ROUND_ID);
  if (!me || !r || r.data.phase !== "play") return idle;
  const d = me.data;
  const from = d.last ? get<PlatformData>(w, d.last) : undefined;
  if (!from) {
    // On the ground (or never landed yet): go to the lowest platform's foot and jump.
    let first: Entity<PlatformData> | null = null;
    for (const pl of bodies<PlatformData>(w, "platform")) {
      if (pl.data.type === "ground" || isHazard(pl.data.type)) continue;
      if (!first || platformTop(pl) > platformTop(first)) first = pl;
    }
    if (!first) return idle;
    const dx = first.x - me.x;
    const jump = me.ground === true && !d.held && Math.abs(dx) < first.data.w / 2 + 20;
    return { dx: Math.abs(dx) > 3 ? Math.sign(dx) : 0, dy: 0, action: jump || (d.jumping && me.vy < 0) };
  }
  const target = nextTarget(w, from);
  if (!target) return idle;
  const dx = target.x - me.x;
  // Bots are fillers, not rivals: about a third of their jumps from a platform are botched.
  let h = n * 2654435761 + r.data.round * 40503 + Math.floor(w.tick / 45) * 97; // changes every 3 s: no bot is stuck botching one jump
  for (let i = 0; i < from.id.length; i++) h = (Math.imul(h, 31) + from.id.charCodeAt(i)) >>> 0;
  const botched = h % 100 < BOT_MISS_PERCENT;
  if (me.ground !== true) {
    // In the air: steer onto the target and hold the jump while rising. A botched jump lets go of
    // the stick at the apex and drops short.
    if (botched && me.vy > 0) return idle;
    return { dx: Math.abs(dx) > 4 ? Math.sign(dx) : 0, dy: 0, action: d.jumping && me.vy < 0 };
  }
  // On a platform: run toward the target; jump once close enough. The lead varies by bot and step, so bots sometimes miss.
  const rise = platformTop(from) - platformTop(target);
  const reach = config.runSpeed * airTicks(rise) * 0.6;
  const wobble = ((n * 7 + w.tick) % 13) / 13; // 0..1, deterministic
  const lead = reach * (botched ? 2.2 : 0.75 + 0.6 * wobble); // a botched jump also takes off far too early
  // About to run off the edge toward the target: jump now (the classic edge jump).
  const nx = me.x + me.vx + Math.sign(dx) * config.groundAccel;
  const atEdge = Math.abs(nx - from.x) > from.data.w / 2 - 1 && Math.sign(dx) === Math.sign(nx - from.x);
  // Bots hesitate before each jump (about 1.5 s on average), like a player lining up; a crumbling floor rushes them.
  const rushed = from.data.warn === true;
  if (!atEdge && !rushed && (w.tick + h) % 40 >= 9) return idle;
  // A target that is off right now (blinking, crumbled): wait for it.
  if (!solid(target) && !atEdge) return idle;
  const jump = !d.held && (Math.abs(dx) <= lead || atEdge);
  return { dx: Math.abs(dx) > 3 ? Math.sign(dx) : 0, dy: 0, action: jump };
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
    updatePlatforms(w);
    let winner: Entity<PlayerData> | null = null;
    for (const p of players) {
      const inp = inputs[p.id];
      const landed = movePlayer(w, p, inp?.dx ?? 0, jumpInput(inp));
      if (touchesHazard(w, p)) {
        p.data.deaths++;
        toGround(w, p, false);
        continue;
      }
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
