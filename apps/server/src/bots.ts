// Idle bots for archived rooms (owner decision): an old week's game feels alive when someone drops
// in, at ~zero cost. Bots are server-side players, never fake WebSocket clients: they join through
// the game's own rules.join, get one input per tick like every player, and rules.step moves them.
// They exist only while at least one real player or spectator is connected (the room does not tick otherwise).
// The AI is deterministic: a pure function of the world and the bot's number, no clocks, no RNG.
import { joinPlayer, leavePlayer, type GameRules, type Input, type World } from "@tcg/shared";

/** An archived room with players is filled up to this many players with bots. */
export const BOT_FILL = 6;
/** Bot player ids. Client connection ids (partysocket `_pk`) with this prefix are refused. */
export const BOT_PREFIX = "bot:";
export const isBotId = (id: string): boolean => id.startsWith(BOT_PREFIX);

/** Bots a room should run: archived and anyone connected (player or spectator) -> fill the players up to BOT_FILL; else none. */
export function botTarget(archived: boolean, humans: number, spectators = 0): number {
  return archived && humans + spectators > 0 ? Math.max(0, BOT_FILL - humans) : 0;
}

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));
const DEAD_PX = 2;

/**
 * Input for bot number `n` (1-based). Steers toward the nearest non-player entity (pellets, pickups,
 * whatever the game spawns), each bot considering every BOT_FILL-th one so they spread out instead of
 * clumping; with nothing to chase it drifts in a slow figure-of-eight. Taps `action` now and then.
 */
export function botInput(w: World, id: string, n: number): Input {
  const action = (w.tick + n * 11) % 45 < 2;
  const me = w.entities[id];
  if (me) {
    let best: { d2: number; x: number; y: number } | null = null;
    let any: { d2: number; x: number; y: number } | null = null;
    let k = 0;
    for (const e of Object.values(w.entities)) {
      if (e.id in w.names) continue; // players and bots
      const d2 = (e.x - me.x) ** 2 + (e.y - me.y) ** 2;
      if (!any || d2 < any.d2) any = { d2, x: e.x, y: e.y };
      if (k++ % BOT_FILL === (n - 1) % BOT_FILL && (!best || d2 < best.d2)) best = { d2, x: e.x, y: e.y };
    }
    const t = best ?? any;
    if (t) {
      const dx = t.x - me.x;
      const dy = t.y - me.y;
      return { dx: Math.abs(dx) > DEAD_PX ? clamp1(dx / 20) : 0, dy: Math.abs(dy) > DEAD_PX ? clamp1(dy / 20) : 0, action };
    }
  }
  const period = 90 + n * 7;
  const a = (((w.tick + n * 23) % period) / period) * Math.PI * 2;
  return { dx: Math.round(Math.cos(a) * 2) / 2, dy: Math.round(Math.sin(2 * a) * 2) / 2, action };
}

/** The bot players of one room: ids bot:1..bot:k, k = the last sync's target. */
export class Bots {
  ids: string[] = [];

  /** Join or remove bots (newest first) until there are exactly `target`. */
  sync(w: World, rules: GameRules, target: number): void {
    while (this.ids.length > target) leavePlayer(w, rules, this.ids.pop()!);
    while (this.ids.length < target) {
      const n = this.ids.length + 1;
      const id = `${BOT_PREFIX}${n}`;
      this.ids.push(id);
      joinPlayer(w, rules, id, `bot ${n}`);
    }
  }

  /** This tick's input for every bot (zero input while `idle`, e.g. a draining room). */
  inputs(w: World, idle = false): Record<string, Input> {
    const out: Record<string, Input> = {};
    this.ids.forEach((id, i) => { out[id] = idle ? { dx: 0, dy: 0, action: false } : botInput(w, id, i + 1); });
    return out;
  }
}
