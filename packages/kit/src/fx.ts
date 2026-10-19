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

// World size and look. The camera clamps to width x height.
export interface Scene {
  width: number;
  height: number;
  // Canvas clear color behind everything.
  background?: string;
  zoom?: number;
}

// What packages/games/<slug>/assets.ts exports. The renderer calls these; everything is optional
// except drawEntity. Entities passed in are already interpolated (others) or predicted (you).
export interface GameAssets<E extends { id: string } = { id: string; kind: string; x: number; y: number; r: number }> {
  scene?: Scene;
  // World space, before entities (floor, grid, level art).
  drawBackground?(ctx: CanvasRenderingContext2D, fx: Fx): void;
  // World space, once per visible entity per frame.
  drawEntity(ctx: CanvasRenderingContext2D, e: E, fx: Fx): void;
  // Screen space, after particles (HUD). Player names are drawn by the host renderer, not here.
  drawOverlay?(ctx: CanvasRenderingContext2D, fx: Fx): void;
  // Once per authoritative snapshot: diff prev -> next to fire particles, sfx, shake.
  onSnapshot?(prev: Readonly<Record<string, E>> | null, next: Readonly<Record<string, E>>, fx: Fx): void;
}
