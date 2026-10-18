// Seeded RNG (mulberry32). State lives in the world so a snapshot carries it:
// server and client advance the exact same sequence. Never use Math.random in sim code.
import type { World } from "./world.js";

export function random(w: World): number {
  let t = (w.rng = (w.rng + 0x6d2b79f5) | 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Uniform float in [min, max).
export function randomRange(w: World, min: number, max: number): number {
  return min + random(w) * (max - min);
}

// Uniform integer in [0, n).
export function randomInt(w: World, n: number): number {
  return Math.floor(random(w) * n);
}
