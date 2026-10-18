// The bundle the client renderer hands to a game's assets.ts every frame.
import { Camera } from "./camera.js";
import { Particles } from "./particles.js";
import { Sfx } from "./sfx.js";

export interface Fx {
  camera: Camera;
  // World-space particles, drawn after entities.
  particles: Particles;
  sfx: Sfx;
  // Seconds since the game page started, and since the last frame.
  time: number;
  dt: number;
  // Own player id (entity id === player id), null before the first snapshot.
  me: string | null;
}

export function createFx(particles = 1024): Fx {
  return { camera: new Camera(), particles: new Particles(particles), sfx: new Sfx(), time: 0, dt: 0, me: null };
}
