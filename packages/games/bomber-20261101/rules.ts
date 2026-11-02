// Agent-editable rules. Pure functions only. See guard script for banned APIs.
// Game: multiplayer grid bomber. Walk the grid, drop a bomb (action), blow up bricks and rivals.
// A bomb burns for 3 s, then blasts a cross that stops at pillars and breaks the first brick it meets.
// Bombs caught in a blast go off in the same tick (chain reaction); every knockout in a chain is
// credited to the player whose bomb started it. Knocked-out players wait 3 s as ghosts, then respawn
// with 2 s of protection. A round lasts 180 s, then 5 s of results and a fresh arena.
//
// The arena lives in the round entity as a tile string (cols x rows, row-major):
// '#' wall / pillar, '.' floor, any other char a block from BLOCK_TYPES.
import { bodies, despawn, get, random, randomInt, spawn, type Entity, type GameRules, type Input, type World } from "@tcg/shared";
import { config } from "./config.js";

// --- extensible lists --------------------------------------------------------------------------------

export interface BlockType {
  name: string;
  char: string; // its char in the tile string (never '#' or '.')
  weight: number; // relative share among generated blocks
  breakable: boolean;
}

export interface PlayerData {
  ko: number; // knockouts scored this round
  bonus: number; // percent extra per knockout from the last chain (0..100)
  score: number; // weighted knockout points this round (decides the winner)
  deaths: number; // times knocked out this round
  dead: boolean; // ghost waiting to respawn
  respawn: number; // ticks until respawn while dead
  protect: number; // ticks of spawn protection left (blasts do not hurt)
  range: number; // blast arm length in cells
  bombs: number; // live bombs allowed at once
  bomb: string; // bomb type name (BOMB_TYPES)
  held: boolean; // action held last tick (a bomb needs a fresh press)
  killer: string; // who knocked this player out last ("" = nobody / self)
  home: number; // cell index of the last (re)spawn
  born: number; // tick of the last (re)spawn
  chain: number; // bomb count of the last chain this player started
  crown: number; // ticks of gold crown left (0 = none)
  mult: number; // ticks of chain score multiplier left (0 = none)
  chainSeq: number; // increments each time a chain this player started finishes (client popup trigger)
}

export interface PickupType {
  name: string;
  weight: number;
  apply(d: PlayerData): void;
}

export interface BombType {
  name: string;
  weight: number;
  fuse: number; // ticks
  rangeBonus: number; // extra cells on top of the owner's range
}

// Day one: plain bricks, one pickup, one bomb. Add entries here; the arena and drops pick from them.
export const BLOCK_TYPES: BlockType[] = [{ name: "brick", char: "b", weight: 1, breakable: true }];

export const PICKUP_TYPES: PickupType[] = [
  { name: "blast+1", weight: 1, apply: (d) => { d.range = Math.min(config.maxBlastRange, d.range + 1); } },
];

export const BOMB_TYPES: BombType[] = [{ name: "normal", weight: 1, fuse: config.fuseTicks, rangeBonus: 0 }];

// --- entity data ---------------------------------------------------------------------------------------

export interface BombData {
  owner: string;
  rootOwner: string; // owner of the bomb that started the chain this bomb goes off in
  fuse: number; // ticks left
  fuseMax: number;
  range: number;
  type: string;
  cx: number;
  cy: number;
}

export interface BlastData {
  owner: string; // the chain's root owner: credited with knockouts
  ticksLeft: number;
  cx: number;
  cy: number;
  up: number; // arm lengths in cells
  down: number;
  left: number;
  right: number;
}

export interface PickupData {
  type: string;
  cx: number;
  cy: number;
}

export interface RoundData {
  phase: "play" | "results";
  ticksLeft: number;
  round: number;
  winner: string; // most knockouts at the end of the last round ("" = nobody scored)
  cols: number;
  rows: number;
  tiles: string;
}

export const ROUND_ID = "round";
const COLS = config.cols;
const ROWS = config.rows;
const C = config.cell;
export const ARENA = { w: COLS * C, h: ROWS * C };
const DIRS: ReadonlyArray<readonly [number, number, "up" | "down" | "left" | "right"]> = [
  [0, -1, "up"], [0, 1, "down"], [-1, 0, "left"], [1, 0, "right"],
];

// --- grid helpers --------------------------------------------------------------------------------------

export const cellOf = (v: number) => Math.floor(v / C);
export const centre = (c: number) => c * C + C / 2;
export const idx = (cx: number, cy: number) => cy * COLS + cx;
const inside = (cx: number, cy: number) => cx >= 0 && cy >= 0 && cx < COLS && cy < ROWS;

export function tileAt(r: RoundData, cx: number, cy: number): string {
  return inside(cx, cy) ? r.tiles[idx(cx, cy)] : "#";
}

export function blockOf(ch: string): BlockType | undefined {
  return BLOCK_TYPES.find((b) => b.char === ch);
}

function setTile(r: RoundData, i: number, ch: string): void {
  r.tiles = r.tiles.slice(0, i) + ch + r.tiles.slice(i + 1);
}

function pickWeighted<T extends { weight: number }>(w: World, list: readonly T[]): T {
  let total = 0;
  for (const t of list) total += t.weight;
  let roll = random(w) * total;
  for (const t of list) {
    roll -= t.weight;
    if (roll < 0) return t;
  }
  return list[list.length - 1];
}

const isWall = (cx: number, cy: number) =>
  cx === 0 || cy === 0 || cx === COLS - 1 || cy === ROWS - 1 || (cx % 2 === 0 && cy % 2 === 0);

/** The four corners stay free so the arena always has open ground. */
const spawnZone = (cx: number, cy: number) => (cx <= 2 || cx >= COLS - 3) && (cy <= 2 || cy >= ROWS - 3);

/** A fresh arena from the world's seeded RNG: border walls, pillars on even cells, random blocks. */
export function buildTiles(w: World): string {
  let out = "";
  for (let cy = 0; cy < ROWS; cy++) {
    for (let cx = 0; cx < COLS; cx++) {
      if (isWall(cx, cy)) out += "#";
      else if (spawnZone(cx, cy)) out += ".";
      else out += random(w) < config.brickChance ? pickWeighted(w, BLOCK_TYPES).char : ".";
    }
  }
  return out;
}

function bombMap(w: World): Map<number, Entity<BombData>> {
  const m = new Map<number, Entity<BombData>>();
  for (const b of bodies<BombData>(w, "bomb")) m.set(idx(b.data.cx, b.data.cy), b);
  return m;
}

export function blastCovers(b: BlastData, cx: number, cy: number): boolean {
  if (cy === b.cy && cx >= b.cx - b.left && cx <= b.cx + b.right) return true;
  return cx === b.cx && cy >= b.cy - b.up && cy <= b.cy + b.down;
}

function blastAt(w: World, cx: number, cy: number): Entity<BlastData> | undefined {
  for (const b of bodies<BlastData>(w, "blast")) if (blastCovers(b.data, cx, cy)) return b;
  return undefined;
}

/** Cells a bomb at (cx, cy) with this range would hit, as the grid stands now. */
export function crossCells(r: RoundData, cx: number, cy: number, range: number): number[] {
  const out = [idx(cx, cy)];
  for (const [dx, dy] of DIRS) {
    for (let k = 1; k <= range; k++) {
      const x = cx + dx * k, y = cy + dy * k;
      const t = tileAt(r, x, y);
      if (t === "#") break;
      out.push(idx(x, y));
      if (t !== ".") break;
    }
  }
  return out;
}

/** Every cell that burns now or will burn when a live bomb goes off. */
export function dangerCells(w: World, r: RoundData): Set<number> {
  const out = new Set<number>();
  for (const b of bodies<BombData>(w, "bomb")) for (const i of crossCells(r, b.data.cx, b.data.cy, b.data.range)) out.add(i);
  for (const b of bodies<BlastData>(w, "blast")) for (const i of blastCells(b.data)) out.add(i);
  return out;
}

/** Cells a blast burns. */
export function blastCells(d: BlastData): number[] {
  const out: number[] = [];
  for (let k = -d.left; k <= d.right; k++) out.push(idx(d.cx + k, d.cy));
  for (let k = -d.up; k <= d.down; k++) if (k !== 0) out.push(idx(d.cx, d.cy + k));
  return out;
}

// --- round -----------------------------------------------------------------------------------------------

function round(w: World): Entity<RoundData> {
  let r = get<RoundData>(w, ROUND_ID);
  if (!r) {
    r = spawn<RoundData>(w, {
      id: ROUND_ID,
      kind: "round",
      x: ARENA.w / 2,
      y: ARENA.h / 2,
      r: 1,
      data: { phase: "play", ticksLeft: config.roundSeconds * config.tickHz, round: 1, winner: "", cols: COLS, rows: ROWS, tiles: buildTiles(w) },
    });
  }
  return r;
}

/** A random free floor cell: no block, bomb, blast or pending danger, with room to move. */
export function freeCell(w: World, r: RoundData): [number, number] {
  const bombs = bombMap(w);
  const danger = dangerCells(w, r);
  const floor = (x: number, y: number) => tileAt(r, x, y) === "." && !bombs.has(idx(x, y));
  const taken = new Set<number>();
  for (const p of bodies<PlayerData>(w, "player")) if (!p.data.dead) taken.add(idx(cellOf(p.x), cellOf(p.y)));
  const best: number[] = [];
  const good: number[] = [];
  const ok: number[] = [];
  for (let cy = 1; cy < ROWS - 1; cy++) {
    for (let cx = 1; cx < COLS - 1; cx++) {
      if (!floor(cx, cy)) continue;
      const i = idx(cx, cy);
      ok.push(i);
      if (danger.has(i)) continue;
      let open = 0;
      for (const [dx, dy] of DIRS) if (floor(cx + dx, cy + dy)) open++;
      if (open < 1) continue;
      good.push(i);
      if (!taken.has(i)) best.push(i);
    }
  }
  // Best: safe, room to move, nobody there. Then safe with room. Then any floor.
  const list = best.length ? best : good.length ? good : ok;
  if (!list.length) return [1, 1];
  const i = list[randomInt(w, list.length)];
  return [i % COLS, Math.floor(i / COLS)];
}

function placePlayer(w: World, r: RoundData, p: Entity<PlayerData>): void {
  const [cx, cy] = freeCell(w, r);
  p.x = centre(cx);
  p.y = centre(cy);
  p.vx = 0;
  p.vy = 0;
  p.data.dead = false;
  p.data.respawn = 0;
  p.data.protect = config.protectTicks;
  p.data.home = idx(cx, cy);
  p.data.born = w.tick;
}

function clearKind(w: World, kind: string): void {
  for (const e of bodies(w, kind)) despawn(w, e.id);
}

function startRound(w: World, r: Entity<RoundData>): void {
  clearKind(w, "bomb");
  clearKind(w, "blast");
  clearKind(w, "pickup");
  r.data.tiles = buildTiles(w);
  r.data.phase = "play";
  r.data.ticksLeft = config.roundSeconds * config.tickHz;
  r.data.winner = "";
  r.data.round++;
  for (const p of bodies<PlayerData>(w, "player")) {
    const d = p.data;
    d.ko = 0;
    d.bonus = 0;
    d.score = 0;
    d.deaths = 0;
    d.range = config.blastRange;
    d.bombs = config.bombsPerPlayer;
    d.bomb = BOMB_TYPES[0].name;
    d.killer = "";
    d.chain = 0;
    d.crown = 0;
    d.mult = 0;
    placePlayer(w, r.data, p);
  }
}

function endRound(w: World, r: Entity<RoundData>): void {
  clearKind(w, "bomb");
  clearKind(w, "blast");
  let best: Entity<PlayerData> | null = null;
  for (const p of bodies<PlayerData>(w, "player")) if (p.data.score > 0 && (!best || p.data.score > best.data.score)) best = p;
  r.data.winner = best ? best.id : "";
  r.data.phase = "results";
  r.data.ticksLeft = config.resultsSeconds * config.tickHz;
  for (const p of bodies<PlayerData>(w, "player")) { p.vx = 0; p.vy = 0; }
}

// --- movement --------------------------------------------------------------------------------------------

/** Moves along one axis by up to `budget` px; returns px moved. Perpendicular misalignment is fixed first. */
function slide(r: RoundData, bombs: Map<number, Entity<BombData>>, p: Entity<PlayerData>, horizontal: boolean, s: number, budget: number): number {
  const cx = cellOf(p.x), cy = cellOf(p.y);
  const tx = horizontal ? cx + s : cx;
  const ty = horizontal ? cy : cy + s;
  const open = tileAt(r, tx, ty) === "." && !bombs.has(idx(tx, ty));
  let used = 0;
  // Corner assist: line up with the row / column first, but only toward an open cell.
  const perp = horizontal ? p.y - centre(cy) : p.x - centre(cx);
  if (perp !== 0) {
    if (!open) return 0;
    const step = Math.min(Math.abs(perp), budget);
    if (horizontal) p.y -= Math.sign(perp) * step;
    else p.x -= Math.sign(perp) * step;
    used = step;
    if (Math.abs(perp) > step) return used;
  }
  const left = budget - used;
  if (left <= 0) return used;
  const pos = horizontal ? p.x : p.y;
  const mid = horizontal ? centre(cx) : centre(cy);
  let next = pos + s * left;
  // A closed cell ahead: stop at the middle of this one (never pushed back).
  if (!open) next = s > 0 ? Math.max(pos, Math.min(next, mid)) : Math.min(pos, Math.max(next, mid));
  if (horizontal) p.x = next;
  else p.y = next;
  return used + Math.abs(next - pos);
}

function movePlayer(r: RoundData, bombs: Map<number, Entity<BombData>>, p: Entity<PlayerData>, inp: Input | undefined): void {
  const x0 = p.x, y0 = p.y;
  const dx = inp?.dx ?? 0, dy = inp?.dy ?? 0;
  const sx = Math.abs(dx) > config.stickDeadZone ? Math.sign(dx) : 0;
  const sy = Math.abs(dy) > config.stickDeadZone ? Math.sign(dy) : 0;
  if (sx || sy) {
    const horizontalFirst = sx !== 0 && (sy === 0 || Math.abs(dx) >= Math.abs(dy));
    const moved = horizontalFirst ? slide(r, bombs, p, true, sx, config.moveSpeed) : slide(r, bombs, p, false, sy, config.moveSpeed);
    // Pushing diagonally into a wall: take the other axis (turning corners feels natural).
    if (moved === 0 && sx && sy) {
      if (horizontalFirst) slide(r, bombs, p, false, sy, config.moveSpeed);
      else slide(r, bombs, p, true, sx, config.moveSpeed);
    }
  }
  p.vx = p.x - x0;
  p.vy = p.y - y0;
}

function liveBombs(w: World, owner: string): number {
  let n = 0;
  for (const b of bodies<BombData>(w, "bomb")) if (b.data.owner === owner) n++;
  return n;
}

function dropBomb(w: World, bombs: Map<number, Entity<BombData>>, p: Entity<PlayerData>): void {
  const cx = cellOf(p.x), cy = cellOf(p.y);
  const i = idx(cx, cy);
  if (bombs.has(i) || liveBombs(w, p.id) >= p.data.bombs) return;
  const type = BOMB_TYPES.find((t) => t.name === p.data.bomb) ?? BOMB_TYPES[0];
  const b = spawn<BombData>(w, {
    kind: "bomb",
    x: centre(cx),
    y: centre(cy),
    r: C * 0.38,
    data: { owner: p.id, rootOwner: p.id, fuse: type.fuse, fuseMax: type.fuse, range: p.data.range + type.rangeBonus, type: type.name, cx, cy },
  });
  bombs.set(i, b);
}

// --- explosions ----------------------------------------------------------------------------------------

function breakBlock(w: World, r: RoundData, cx: number, cy: number): void {
  setTile(r, idx(cx, cy), ".");
  if (PICKUP_TYPES.length && random(w) < config.pickupChance) {
    const t = pickWeighted(w, PICKUP_TYPES);
    spawn<PickupData>(w, { kind: "pickup", x: centre(cx), y: centre(cy), r: C * 0.3, data: { type: t.name, cx, cy } });
  }
}

/**
 * Burns down fuses and sets off due bombs. A bomb inside a blast (new or still burning) goes off in the
 * same tick and inherits the chain's root owner; this repeats until no bomb is left to trigger.
 */
function explodeBombs(w: World, r: RoundData): void {
  const bombs = bombMap(w);
  const queue: Entity<BombData>[] = [];
  const going = new Set<string>();
  for (const b of bodies<BombData>(w, "bomb")) {
    b.data.fuse--;
    const burning = blastAt(w, b.data.cx, b.data.cy);
    if (burning) b.data.rootOwner = burning.data.owner;
    if (b.data.fuse <= 0 || burning) { queue.push(b); going.add(b.id); }
  }
  const broken = new Set<number>(); // blocks broken this tick still stop later arms
  for (let q = 0; q < queue.length; q++) {
    const b = queue[q];
    const arms = { up: 0, down: 0, left: 0, right: 0 };
    for (const [dx, dy, name] of DIRS) {
      for (let k = 1; k <= b.data.range; k++) {
        const x = b.data.cx + dx * k, y = b.data.cy + dy * k;
        const i = idx(x, y);
        const t = tileAt(r, x, y);
        if (t === "#") break;
        arms[name] = k;
        if (broken.has(i)) break;
        if (t !== ".") {
          if (blockOf(t)?.breakable !== false) { broken.add(i); breakBlock(w, r, x, y); }
          break;
        }
        const other = bombs.get(i);
        if (other) {
          if (!going.has(other.id)) {
            other.data.rootOwner = b.data.rootOwner;
            going.add(other.id);
            queue.push(other);
          }
          break;
        }
      }
    }
    despawn(w, b.id);
    bombs.delete(idx(b.data.cx, b.data.cy));
    spawn<BlastData>(w, {
      kind: "blast",
      x: b.x,
      y: b.y,
      r: C / 2,
      data: { owner: b.data.rootOwner, ticksLeft: config.blastTicks, cx: b.data.cx, cy: b.data.cy, ...arms },
    });
  }
  // Chain finished: record its size on each root owner (Map keeps insertion order: deterministic).
  const sizes = new Map<string, number>();
  for (const b of queue) sizes.set(b.data.rootOwner, (sizes.get(b.data.rootOwner) ?? 0) + 1);
  for (const [owner, n] of sizes) {
    const p = get<PlayerData>(w, owner);
    if (p && p.kind === "player") {
      p.data.chain = n;
      p.data.bonus = Math.min(100, Math.max(0, n - 3) * 10);
      p.data.chainSeq++;
      p.data.mult = n >= config.chainMultMinChain ? config.chainMultTicks : 0;
    }
  }
  // Crown: the longest chain (at least 1 bomb) wears it. A player who just finished a chain that
  // matches the max takes it from the holder; a shorter chain never steals it.
  let max = 0;
  const all = bodies<PlayerData>(w, "player");
  for (const p of all) if (p.data.chain > max) max = p.data.chain;
  if (max >= 1) {
    let leader: Entity<PlayerData> | undefined;
    for (const owner of sizes.keys()) {
      const p = get<PlayerData>(w, owner);
      if (p && p.kind === "player" && p.data.chain === max) { leader = p; break; }
    }
    if (leader) {
      for (const p of all) p.data.crown = p === leader ? config.crownTicks : 0;
    }
  }
}

function ageBlasts(w: World): void {
  for (const b of bodies<BlastData>(w, "blast")) if (--b.data.ticksLeft <= 0) despawn(w, b.id);
}

function knockOut(w: World, p: Entity<PlayerData>, killer: string): void {
  const d = p.data;
  d.dead = true;
  d.respawn = config.respawnTicks;
  d.protect = 0;
  d.deaths++;
  d.held = false;
  d.killer = killer === p.id ? "" : killer;
  p.vx = 0;
  p.vy = 0;
  const k = killer !== p.id ? get<PlayerData>(w, killer) : undefined;
  if (k && k.kind === "player") {
    k.data.ko++;
    k.data.score += (1 + k.data.bonus / 100) * (k.data.mult > 0 ? config.chainMultFactor : 1);
  }
}

// --- bots ------------------------------------------------------------------------------------------------

const BOT_CAUTION_TICKS = 20; // bots do not cross a bomb's line once its fuse is this short
const BOT_SETTLE_TICKS = 15; // bots do not bomb in their first second after a spawn
const BOT_AWAY_TICKS = 45; // ... and do not walk back onto their spawn cell for 3 s

function hash(...n: number[]): number {
  let h = 2166136261;
  for (const v of n) h = Math.imul(h ^ (v | 0), 16777619) >>> 0;
  return h;
}

/** Breadth-first search over cells; returns distances (-1 = unreachable) and the previous cell on the path. */
function bfs(start: number, open: (i: number) => boolean): { dist: Int16Array; prev: Int16Array } {
  const dist = new Int16Array(COLS * ROWS).fill(-1);
  const prev = new Int16Array(COLS * ROWS).fill(-1);
  dist[start] = 0;
  const q = [start];
  for (let h = 0; h < q.length; h++) {
    const c = q[h];
    const cx = c % COLS, cy = Math.floor(c / COLS);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (!inside(nx, ny)) continue;
      const n = idx(nx, ny);
      if (dist[n] >= 0 || !open(n)) continue;
      dist[n] = dist[c] + 1;
      prev[n] = c;
      q.push(n);
    }
  }
  return { dist, prev };
}

function firstStep(prev: Int16Array, start: number, target: number): number {
  let c = target;
  while (prev[c] >= 0 && prev[c] !== start) c = prev[c];
  return c;
}

function steer(me: Entity<PlayerData>, cell: number, action: boolean): Input {
  const tx = centre(cell % COLS), ty = centre(Math.floor(cell / COLS));
  const ddx = tx - me.x, ddy = ty - me.y;
  return { dx: Math.abs(ddx) > 1 ? Math.sign(ddx) : 0, dy: Math.abs(ddy) > 1 ? Math.sign(ddy) : 0, action };
}

/** Bot: flee danger, bomb bricks and rivals when it can get away, otherwise walk to the next target. */
function botInput(w: World, id: string, n: number): Input {
  const idle: Input = { dx: 0, dy: 0, action: false };
  const me = get<PlayerData>(w, id);
  const re = get<RoundData>(w, ROUND_ID);
  if (!me || !re || re.data.phase !== "play" || me.data.dead) return idle;
  const r = re.data;
  const bombs = bombMap(w);
  const danger = dangerCells(w, r);
  const burning = new Set<number>();
  for (const b of bodies<BlastData>(w, "blast")) for (const i of blastCells(b.data)) burning.add(i);
  const start = idx(cellOf(me.x), cellOf(me.y));
  // For 3 s after a spawn a bot does not go back to its spawn cell: it spreads out from the crowd.
  const away = w.tick - me.data.born < BOT_AWAY_TICKS && me.data.home !== start ? me.data.home : -1;
  const walkable = (i: number) => r.tiles[i] === "." && !bombs.has(i) && !burning.has(i) && i !== away;

  if (danger.has(start)) {
    const { dist, prev } = bfs(start, walkable);
    let best = -1;
    for (let i = 0; i < dist.length; i++) if (dist[i] > 0 && !danger.has(i) && (best < 0 || dist[i] < dist[best])) best = i;
    // No safe cell in reach: get as far away as possible and hope.
    if (best < 0) for (let i = 0; i < dist.length; i++) if (dist[i] > 0 && (best < 0 || dist[i] > dist[best])) best = i;
    return best < 0 ? steer(me, start, false) : steer(me, firstStep(prev, start, best), false);
  }

  const rivals = bodies<PlayerData>(w, "player").filter((p) => p.id !== id && !p.data.dead);
  const worth = (i: number): boolean => {
    const cx = i % COLS, cy = Math.floor(i / COLS);
    for (const [dx, dy] of DIRS) { const t = tileAt(r, cx + dx, cy + dy); if (t !== "#" && t !== ".") return true; }
    const hit = new Set(crossCells(r, cx, cy, me.data.range));
    return rivals.some((p) => p.data.protect <= 0 && hit.has(idx(cellOf(p.x), cellOf(p.y))));
  };

  // A good spot with a way out: wait here for the bot's turn to bomb. Fresh spawns hold off for a second
  // and bots take turns (each on its own tick of 7), so neighbours never wall each other in at once.
  /** A cell to bomb from: something to hit and a safe cell within 4 steps of it. */
  const spot = (i: number): boolean => {
    if (danger.has(i) || !worth(i)) return false;
    const after = new Set(danger);
    for (const c of crossCells(r, i % COLS, Math.floor(i / COLS), me.data.range)) after.add(c);
    const { dist } = bfs(i, walkable);
    for (let c = 0; c < dist.length; c++) if (dist[c] > 0 && dist[c] <= 4 && !after.has(c)) return true;
    return false;
  };
  // Fresh spawn: first step off the spawn cell to a fixed open neighbour, so a crowd that spawns
  // together spreads out (and visibly starts moving) before anyone bombs.
  if (me.data.protect > config.protectTicks - BOT_SETTLE_TICKS && me.data.home >= 0) {
    const hx = me.data.home % COLS, hy = Math.floor(me.data.home / COLS);
    const open: number[] = [];
    for (const [dx, dy] of DIRS) if (walkable(idx(hx + dx, hy + dy))) open.push(idx(hx + dx, hy + dy));
    if (open.length) return steer(me, open[hash(n, me.data.home, r.round) % open.length], false);
  }
  const armed = liveBombs(w, id) < me.data.bombs;
  if (armed && spot(start)) {
    const settling = me.data.protect > config.protectTicks - BOT_SETTLE_TICKS;
    if (!settling && (w.tick + n * 5) % 7 === 0 && !me.data.held) return { dx: 0, dy: 0, action: true };
    return steer(me, start, false); // wait here for the turn
  }

  // Walk through lines of bombs that are still far from going off; stop only on safe cells.
  const soon = new Set(burning);
  for (const b of bodies<BombData>(w, "bomb")) {
    if (b.data.fuse <= BOT_CAUTION_TICKS) for (const i of crossCells(r, b.data.cx, b.data.cy, b.data.range)) soon.add(i);
  }
  const { dist, prev } = bfs(start, (i) => walkable(i) && !soon.has(i));
  const slot = Math.floor((w.tick + n * 11) / 30);
  let best = -1;
  if (armed) {
    // Nearest first (ties broken by a fixed per-bot order), so every step brings the bot closer and it
    // never ping-pongs. The escape check is costly: only the nearest few candidates get it.
    const cands: Array<[number, number, number]> = [];
    for (let i = 0; i < dist.length; i++) {
      if (dist[i] <= 0 || danger.has(i) || !worth(i)) continue;
      cands.push([dist[i], hash(n, i, r.round), i]);
    }
    cands.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
    for (let k = 0; k < cands.length && k < 8 && best < 0; k++) if (spot(cands[k][2])) best = cands[k][2];
  }
  if (best < 0) {
    // Nothing worth bombing in reach: wander to some reachable cell. The own cell counts too, so the
    // list (and the pick) stays the same while the bot walks: no ping-pong.
    const reach: number[] = [];
    for (let i = 0; i < dist.length; i++) if (dist[i] >= 0 && !danger.has(i)) reach.push(i);
    if (!reach.length) return steer(me, start, false);
    best = reach[hash(n, slot, r.round) % reach.length];
  }
  return steer(me, best === start ? start : firstStep(prev, start, best), false);
}

// --- rules -----------------------------------------------------------------------------------------------

export function newPlayerData(): PlayerData {
  return { ko: 0, deaths: 0, dead: false, respawn: 0, protect: 0, range: config.blastRange, bombs: config.bombsPerPlayer, bomb: BOMB_TYPES[0].name, held: false, killer: "", home: -1, born: 0, chain: 0, crown: 0, mult: 0, chainSeq: 0, bonus: 0, score: 0 };
}

export const rules: GameRules = {
  arena: ARENA,
  init(w) {
    round(w);
  },
  join(w, playerId) {
    const r = round(w);
    const p = spawn<PlayerData>(w, { id: playerId, kind: "player", r: config.playerR, data: newPlayerData() });
    placePlayer(w, r.data, p);
  },
  bot: botInput,
  step(w, inputs) {
    const re = round(w);
    const r = re.data;
    if (r.phase === "results") {
      if (--r.ticksLeft <= 0) startRound(w, re);
      return;
    }
    ageBlasts(w);
    explodeBombs(w, r);
    const bombs = bombMap(w);
    const players = bodies<PlayerData>(w, "player");
    for (const p of players) {
      const d = p.data;
      const inp = inputs[p.id];
      if (d.crown > 0) d.crown--;
      if (d.mult > 0) d.mult--;
      if (d.dead) {
        p.vx = 0;
        p.vy = 0;
        if (--d.respawn <= 0) placePlayer(w, r, p);
        continue;
      }
      if (d.protect > 0) d.protect--;
      movePlayer(r, bombs, p, inp);
      const action = inp?.action ?? false;
      if (action && !d.held) dropBomb(w, bombs, p);
      d.held = action;
      const cx = cellOf(p.x), cy = cellOf(p.y);
      for (const k of bodies<PickupData>(w, "pickup")) {
        if (k.data.cx !== cx || k.data.cy !== cy) continue;
        PICKUP_TYPES.find((t) => t.name === k.data.type)?.apply(d);
        despawn(w, k.id);
      }
    }
    for (const p of players) {
      if (p.data.dead || p.data.protect > 0) continue;
      const b = blastAt(w, cellOf(p.x), cellOf(p.y));
      if (b) knockOut(w, p, b.data.owner);
    }
    if (--r.ticksLeft <= 0) endRound(w, re);
  },
};
