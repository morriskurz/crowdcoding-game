// Deterministic 2D physics for circle bodies against static boxes and each other.
// Frozen infrastructure. Pure functions; only + - * / and Math.sqrt (IEEE-exact everywhere),
// no trig, so server and client produce bit-identical results.
// Coordinates: y grows downward. Velocity in px/tick.
import type { Entity } from "./world.js";

// Axis-aligned box: top-left corner + size. Used for level geometry and world bounds.
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PhysicsOpts {
  // Added to vy every tick (px/tick²). Platformer ~0.6, top-down 0.
  gravity?: number;
  // Fraction of velocity lost per tick, 0..1.
  drag?: number;
  // Speed cap (px/tick), applied after gravity and drag.
  maxSpeed?: number;
  // 0 = stop on impact, 1 = perfect bounce.
  bounce?: number;
  // Bodies are kept inside this box; touching its bottom counts as ground.
  bounds?: Box;
  // Static solids (platforms, walls).
  solids?: readonly Box[];
}

export interface Contact {
  // Unit normal pointing from the obstacle toward the body.
  nx: number;
  ny: number;
  depth: number;
}

// A contact counts as ground when its normal points mostly up.
const GROUND_NY = -0.7;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function circlesOverlap(a: Entity, b: Entity): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const rr = a.r + b.r;
  return dx * dx + dy * dy < rr * rr;
}

export function circleBoxContact(e: Entity, b: Box): Contact | null {
  const cx = clamp(e.x, b.x, b.x + b.w);
  const cy = clamp(e.y, b.y, b.y + b.h);
  const dx = e.x - cx;
  const dy = e.y - cy;
  const d2 = dx * dx + dy * dy;
  if (d2 > 0) {
    if (d2 >= e.r * e.r) return null;
    const d = Math.sqrt(d2);
    return { nx: dx / d, ny: dy / d, depth: e.r - d };
  }
  // Center inside the box: push out through the nearest face.
  const left = e.x - b.x;
  const right = b.x + b.w - e.x;
  const top = e.y - b.y;
  const bottom = b.y + b.h - e.y;
  const m = Math.min(left, right, top, bottom);
  if (m === top) return { nx: 0, ny: -1, depth: top + e.r };
  if (m === bottom) return { nx: 0, ny: 1, depth: bottom + e.r };
  if (m === left) return { nx: -1, ny: 0, depth: left + e.r };
  return { nx: 1, ny: 0, depth: right + e.r };
}

// Move the body out along the contact normal and remove (or reflect) the velocity into it.
function resolve(e: Entity, c: Contact, bounce: number): void {
  e.x += c.nx * c.depth;
  e.y += c.ny * c.depth;
  const vn = e.vx * c.nx + e.vy * c.ny;
  if (vn < 0) {
    const k = (1 + bounce) * vn;
    e.vx -= k * c.nx;
    e.vy -= k * c.ny;
  }
  if (c.ny < GROUND_NY) e.ground = true;
}

// Keep a circle fully inside a box. Returns true if it touches the bottom edge.
export function confine(e: Entity, b: Box, bounce = 0): boolean {
  let floor = false;
  if (e.x - e.r < b.x) { e.x = b.x + e.r; if (e.vx < 0) e.vx = -e.vx * bounce; }
  else if (e.x + e.r > b.x + b.w) { e.x = b.x + b.w - e.r; if (e.vx > 0) e.vx = -e.vx * bounce; }
  if (e.y - e.r < b.y) { e.y = b.y + e.r; if (e.vy < 0) e.vy = -e.vy * bounce; }
  else if (e.y + e.r >= b.y + b.h) { e.y = b.y + b.h - e.r; if (e.vy > 0) e.vy = -e.vy * bounce; floor = true; }
  if (floor) e.ground = true;
  return floor;
}

// Advance one body by one tick: gravity, drag, speed cap, then movement in substeps of at most
// r px so fast bodies never tunnel through solids. Sets e.ground.
export function moveBody(e: Entity, o: PhysicsOpts = {}): void {
  const bounce = o.bounce ?? 0;
  e.vy += o.gravity ?? 0;
  if (o.drag) { e.vx *= 1 - o.drag; e.vy *= 1 - o.drag; }
  if (o.maxSpeed !== undefined) {
    const s2 = e.vx * e.vx + e.vy * e.vy;
    if (s2 > o.maxSpeed * o.maxSpeed) {
      const k = o.maxSpeed / Math.sqrt(s2);
      e.vx *= k; e.vy *= k;
    }
  }
  e.ground = false;
  const dist = Math.max(Math.abs(e.vx), Math.abs(e.vy));
  const n = e.r > 0 && dist > e.r ? Math.min(64, Math.ceil(dist / e.r)) : 1;
  // Each substep uses the current velocity, so a body that lands stops moving into the floor.
  for (let i = 0; i < n; i++) {
    e.x += e.vx / n;
    e.y += e.vy / n;
    if (o.solids) {
      for (const b of o.solids) {
        const c = circleBoxContact(e, b);
        if (c) resolve(e, c, bounce);
      }
    }
    if (o.bounds) confine(e, o.bounds, bounce);
  }
}

// Push two overlapping circles apart (heavier = bigger r² moves less) and cancel their
// approaching velocity. Returns true if they overlapped.
export function separate(a: Entity, b: Entity): boolean {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  const rr = a.r + b.r;
  const d2 = dx * dx + dy * dy;
  if (d2 >= rr * rr) return false;
  let d = Math.sqrt(d2);
  if (d === 0) { dx = 1; dy = 0; d = 1; } // exact overlap: deterministic split along x
  const nx = dx / d;
  const ny = dy / d;
  const depth = rr - (d2 === 0 ? 0 : d);
  const ma = a.r * a.r;
  const mb = b.r * b.r;
  const total = ma + mb || 1;
  const ka = mb / total;
  const kb = ma / total;
  a.x -= nx * depth * ka; a.y -= ny * depth * ka;
  b.x += nx * depth * kb; b.y += ny * depth * kb;
  const vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (vn < 0) {
    a.vx += nx * vn * ka; a.vy += ny * vn * ka;
    b.vx -= nx * vn * kb; b.vy -= ny * vn * kb;
  }
  return true;
}

// Move every body, then separate every overlapping pair (in array order: deterministic).
// Pass `collide: false` for bodies that should pass through each other (pellets, ghosts).
export function stepPhysics(list: readonly Entity[], o: PhysicsOpts & { collide?: boolean } = {}): void {
  for (const e of list) moveBody(e, o);
  if (o.collide === false) return;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) separate(list[i], list[j]);
  }
  // Separation can push bodies back into walls; re-apply static constraints once.
  for (const e of list) {
    if (o.solids) for (const b of o.solids) { const c = circleBoxContact(e, b); if (c) resolve(e, c, o.bounce ?? 0); }
    if (o.bounds) confine(e, o.bounds, o.bounce ?? 0);
  }
}
