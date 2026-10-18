import type { Entity, World } from "./sim/world.js";
import { z } from "zod";

// Client -> server: inputs only. No code, no URLs, no free text.
export const InputSchema = z.object({
  v: z.number().int().default(2),
  dx: z.number().min(-1).max(1),
  dy: z.number().min(-1).max(1),
  action: z.boolean().optional().default(false),
});
export type ClientInput = z.infer<typeof InputSchema>;

// Server -> client: full/delta snapshot
export const SnapshotSchema = z.object({
  tick: z.number(),
  version: z.number(),
  // opaque, validated in sim.ts
  patch: z.any(),
});

// Server -> client tick broadcast ({t:"snap"}). Additive-only (spec §12).

export interface LegacyPlayer { id: string; name: string; x: number; y: number; dx: number; dy: number; size: number; alive: boolean }

export interface SnapMessage {
  t: "snap";
  tick: number;
  version: string;
  draining: boolean;
  // v3: generic entity sim.
  entities?: Record<string, Entity>;
  names?: Record<string, string>;
  rng?: number;
  // v2 (agar-only), derived from entities. Deprecated: drop when no v2 client is left (§12, 1 week).
  players: Record<string, LegacyPlayer>;
  pellets: { x: number; y: number }[];
}

export function snapMessage(w: World, version: string, draining: boolean): SnapMessage {
  const players: Record<string, LegacyPlayer> = {};
  const pellets: { x: number; y: number }[] = [];
  for (const e of Object.values(w.entities)) {
    if (e.kind === "player") players[e.id] = { id: e.id, name: w.names[e.id] ?? e.id, x: e.x, y: e.y, dx: e.vx, dy: e.vy, size: e.r, alive: true };
    else if (e.kind === "pellet") pellets.push({ x: e.x, y: e.y });
  }
  return { t: "snap", tick: w.tick, version, draining, entities: w.entities, names: w.names, rng: w.rng, players, pellets };
}
