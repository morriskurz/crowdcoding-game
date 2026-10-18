// Client-side prediction + server reconciliation on top of the deterministic sim.
// Frozen infrastructure. The client runs the exact same runTick + rules as the server.
//
// Inputs are sent only when they change (the server rate-limits at 10 msg/s and holds the last
// input per player), each tagged with an increasing `seq`. After every tick the server reports,
// per player, which seq it applied and for how many consecutive ticks: ack = [seq, ticks].
// The client keeps one frame per locally predicted tick; on a snapshot it drops the frames the
// server has already applied and replays the rest on top of the authoritative state.
import { runTick, type GameRules, type Input, type World, type Entity } from "./world.js";

// [seq of the input applied this tick, consecutive ticks it has been applied so far].
export type Ack = [seq: number, ticks: number];
// Compact input on the wire: [dx, dy, action ? 1 : 0].
export type PackedInput = [number, number, number];

export const packInput = (i: Input): PackedInput => [i.dx, i.dy, i.action ? 1 : 0];
export const unpackInput = (p: PackedInput): Input => ({ dx: p[0], dy: p[1], action: p[2] === 1 });

// Server side: tracks which input seq each player's ticks used.
export class InputAcks {
  // Latest received seq per player. A player starts at seq 0 = the zero input set on join.
  seq: Record<string, number> = {};
  acks: Record<string, Ack> = {};

  join(id: string): void { this.seq[id] = 0; delete this.acks[id]; }
  leave(id: string): void { delete this.seq[id]; delete this.acks[id]; }

  // A new input arrived. Out-of-order (older) seqs are ignored; returns false for those so the
  // caller keeps the newer input it already holds.
  received(id: string, seq: number | undefined): boolean {
    if (seq === undefined) return true; // legacy client without seq: always newest
    if (seq < (this.seq[id] ?? 0)) return false;
    this.seq[id] = seq;
    return true;
  }

  // Call right after runTick, with the ids whose inputs that tick used.
  ticked(ids: Iterable<string>): void {
    for (const id of ids) {
      const s = this.seq[id] ?? 0;
      const a = this.acks[id];
      if (a && a[0] === s) a[1]++;
      else this.acks[id] = [s, 1];
    }
  }
}

// What reconcile() needs from a snapshot (a SnapMessage carries all of it).
export interface PredictSnap {
  tick: number;
  entities?: Record<string, Entity>;
  names?: Record<string, string>;
  rng?: number;
  nextId?: number;
  acks?: Record<string, Ack>;
  inputs?: Record<string, PackedInput>;
}

export interface Frame { seq: number; input: Input }

export function worldFromSnap(s: PredictSnap, version = 0): World {
  // Deep copy: prediction mutates entities, the snapshot is also used for interpolation.
  const entities = JSON.parse(JSON.stringify(s.entities ?? {})) as Record<string, Entity>;
  let nextId = s.nextId;
  if (nextId === undefined) {
    // Older server: derive a safe id counter from the e<N> ids present.
    nextId = 1;
    for (const id in entities) { const m = /^e(\d+)$/.exec(id); if (m) nextId = Math.max(nextId, Number(m[1]) + 1); }
  }
  return { tick: s.tick, version, rng: (s.rng ?? 1) >>> 0, nextId, entities, names: { ...(s.names ?? {}) } };
}

export class Predictor {
  // Predicted world: authoritative state + replayed unconfirmed frames. null until the first snapshot.
  world: World | null = null;
  // Unconfirmed local frames, oldest first.
  pending: Frame[] = [];
  // Last authoritative snapshot tick.
  serverTick = -1;
  // Frames dropped so far for the seq the server currently acks (see reconcile).
  private droppedSeq = -1;
  private droppedCount = 0;
  private others: Record<string, Input> = {};

  // `maxPending`: frames kept unconfirmed before the oldest are dropped (~4 s at 15 Hz).
  constructor(readonly rules: GameRules, public me: string, readonly maxPending = 60) {}

  // Advance the predicted world one local tick with this player's input (and its seq).
  step(input: Input, seq: number): void {
    this.pending.push({ seq, input: { ...input } });
    if (this.pending.length > this.maxPending) this.pending.shift();
    if (this.world) this.tick(this.world, input);
  }

  // Apply an authoritative snapshot: rebase onto it and replay what the server has not applied yet.
  // Returns false when the snapshot cannot be used for prediction (no acks for this player).
  reconcile(s: PredictSnap): boolean {
    if (s.tick < this.serverTick && this.serverTick - s.tick < 30) return true; // stale, keep newer state
    const ack = s.acks?.[this.me];
    this.serverTick = s.tick;
    this.others = {};
    for (const [id, p] of Object.entries(s.inputs ?? {})) this.others[id] = unpackInput(p);
    this.world = worldFromSnap(s, this.world?.version ?? 0);
    if (!ack) { this.pending = []; return false; }
    const [seq, ticks] = ack;
    if (seq !== this.droppedSeq) { this.droppedSeq = seq; this.droppedCount = 0; }
    let i = 0;
    // Everything older than the acked input is confirmed.
    while (i < this.pending.length && this.pending[i].seq < seq) i++;
    // The acked input has run `ticks` times on the server; drop that many frames of it (minus any
    // already dropped by earlier snapshots).
    while (i < this.pending.length && this.pending[i].seq === seq && this.droppedCount < ticks) { i++; this.droppedCount++; }
    this.pending.splice(0, i);
    for (const f of this.pending) this.tick(this.world, f.input);
    return true;
  }

  private tick(w: World, input: Input): void {
    // Other players keep their last known input: exactly what the server does until a new one arrives.
    // Same keys in the same (join) order as the server's input map.
    const inputs: Record<string, Input> = { ...this.others };
    if (!Object.keys(inputs).length) for (const id in w.names) inputs[id] = { dx: 0, dy: 0, action: false };
    if (this.me in inputs || this.me in w.names) inputs[this.me] = input;
    runTick(w, this.rules, inputs);
  }
}
