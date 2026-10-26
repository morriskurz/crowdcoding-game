// Generic entity sim. Frozen infrastructure: games never edit this file.
// Pure: no IO, no Date, no Math.random (use ./rng.ts). Runs identically on server and client.
import { PROTOCOL_VERSION } from "../constants.js";

// One thing in the world: player, pellet, projectile, crate...
// Every body is a circle of radius r. Static level geometry is Box[] (see physics.ts).
// Units: pixels, velocity in px/tick (no dt, keeps float math identical everywhere).
export interface Entity<D extends object = Record<string, unknown>> {
  id: string;
  kind: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  // Game-owned state. Must stay JSON-serializable (it goes over the wire).
  data: D;
  // Set by physics: true when resting on a solid or the bottom bound this tick.
  ground?: boolean;
}

export interface World {
  tick: number;
  version: number;
  // RNG state (uint32). Advanced only by rng.ts.
  rng: number;
  nextId: number;
  // Insertion-ordered; iterate with bodies() for a deterministic order.
  entities: Record<string, Entity>;
  // playerId -> display name. The host draws names, never game code (spec §10).
  names: Record<string, string>;
}

// Per-player input, latest value held by the server (clients send only on change).
export interface Input {
  dx: number;
  dy: number;
  action: boolean;
}

// What packages/games/<slug>/rules.ts exports as `rules`.
export interface GameRules {
  // Called once on a fresh world: spawn level entities.
  init?(w: World): void;
  // Spawn the player's entity. Convention: entity id === playerId.
  join(w: World, playerId: string, name: string): void;
  // Default: despawn(w, playerId).
  leave?(w: World, playerId: string): void;
  // One 15Hz tick. inputs has an entry for every connected player.
  step(w: World, inputs: Readonly<Record<string, Input>>): void;
  // Optional: input for server bot `playerId` (bot number n, 1-based) this tick. Pure function of the
  // world, like a client reading the screen. Without it the server's generic bot plays.
  bot?(w: World, playerId: string, n: number): Input;
  // Optional, presentation only (the live server never calls it): stage the newest feature for the
  // before/after clip. Called every tick before step() for the hero bot `heroId`, whom the camera
  // follows. May change the world (spawn the new thing in the hero's path, trigger the event) and
  // returns the hero's input. Show the new thing happening to the hero about 3 times in 10 s.
  showcase?(w: World, heroId: string, tick: number): Input;
  // Playable area in world units. The server reports entities outside it or too big for it on /health,
  // so a feature that breaks the game shows up and the next feature can fix it.
  arena?: { w: number; h: number };
}

export function createWorld(seed = 1): World {
  return { tick: 0, version: PROTOCOL_VERSION, rng: seed >>> 0, nextId: 1, entities: {}, names: {} };
}

export type SpawnSpec<D extends object> = Partial<Omit<Entity<D>, "kind" | "data">> & { kind: string; data?: D };

export function spawn<D extends object = Record<string, unknown>>(w: World, spec: SpawnSpec<D>): Entity<D> {
  const e: Entity<D> = {
    id: spec.id ?? `e${w.nextId++}`,
    kind: spec.kind,
    x: spec.x ?? 0,
    y: spec.y ?? 0,
    vx: spec.vx ?? 0,
    vy: spec.vy ?? 0,
    r: spec.r ?? 8,
    data: spec.data ?? ({} as D),
  };
  w.entities[e.id] = e as Entity;
  return e;
}

export function despawn(w: World, id: string): void {
  delete w.entities[id];
}

export function get<D extends object = Record<string, unknown>>(w: World, id: string): Entity<D> | undefined {
  return w.entities[id] as Entity<D> | undefined;
}

// Snapshot of entities, optionally filtered by kind. Safe to despawn while iterating the result.
export function bodies<D extends object = Record<string, unknown>>(w: World, kind?: string): Entity<D>[] {
  const all = Object.values(w.entities) as Entity<D>[];
  return kind === undefined ? all : all.filter((e) => e.kind === kind);
}

export function joinPlayer(w: World, rules: GameRules, playerId: string, name: string): void {
  w.names[playerId] = name.slice(0, 16);
  rules.join(w, playerId, w.names[playerId]);
}

export function leavePlayer(w: World, rules: GameRules, playerId: string): void {
  if (rules.leave) rules.leave(w, playerId);
  else despawn(w, playerId);
  delete w.names[playerId];
}

export function runTick(w: World, rules: GameRules, inputs: Readonly<Record<string, Input>>): World {
  w.tick++;
  rules.step(w, inputs);
  return w;
}
