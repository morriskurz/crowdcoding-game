// Idle bots (owner decisions): an old week's game feels alive when someone drops in, and the current
// game is never an empty arena on stream, at ~zero cost. Bots are server-side players, never fake WebSocket clients: they join through
// the game's own rules.join, get one input per tick like every player, and rules.step moves them.
// They exist only while at least one real player or spectator is connected (the room does not tick otherwise).
// The AI is deterministic: a pure function of the world and the bot's number, no clocks, no RNG.
import { joinPlayer, leavePlayer, type GameRules, type Input, type World } from "@tcg/shared";

/** An archived room with players is filled up to this many players with bots. */
export const BOT_FILL = 6;
/**
 * The current game is filled up to this many players while anyone watches, so the stream never shows an
 * empty arena (owner decision 2026-10-24). Fewer than an archive: real players should still matter.
 */
export const CURRENT_FILL = 3;
/** Bot player ids. Client connection ids (partysocket `_pk`) with this prefix are refused. */
export const BOT_PREFIX = "bot:";
export const isBotId = (id: string): boolean => id.startsWith(BOT_PREFIX);

/** Bots a room should run: anyone connected (player or spectator) -> fill the players up to BOT_FILL (archive) or CURRENT_FILL; else none. */
export function botTarget(archived: boolean, humans: number, spectators = 0): number {
  return humans + spectators > 0 ? Math.max(0, (archived ? BOT_FILL : CURRENT_FILL) - humans) : 0;
}

/**
 * Bots are named after the chat's top suggesters (owner decision 2026-10-25): the tcg-bot leaderboard
 * ranks chatters by upvotes on their shipped features. Bot n takes the n-th name, " bot" marks it as
 * a bot (16 chars, the player name limit). Without a name it stays "bot n".
 */
export function botLabel(name: string | undefined, n: number): string {
  const clean = (name ?? "").replace(/[^a-z0-9_]/gi, "").slice(0, 12);
  return clean ? `${clean} bot` : `bot ${n}`;
}

/** How often a room asks the chat bot for the current top names. */
export const BOT_NAMES_MS = 10 * 60_000;

/** The `CHAT_BOT` service binding (tcg-bot worker): just enough of a Fetcher. */
export interface NameSource { fetch: (input: string) => Promise<Response> }

/** Top chatter names from tcg-bot's `GET /leaderboard`, best first; null when unreachable or malformed. */
export async function fetchBotNames(src: NameSource | undefined, limit = BOT_FILL): Promise<string[] | null> {
  if (!src) return null;
  try {
    const r = await src.fetch(`https://tcg-bot/leaderboard?limit=${limit}`);
    if (!r.ok) return null;
    const rows: unknown = await r.json();
    if (!Array.isArray(rows)) return null;
    return rows.map((x) => (typeof x?.name === "string" ? x.name : "")).filter(Boolean).slice(0, limit);
  } catch {
    return null;
  }
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
  /** Top chatter names (fetchBotNames); bot n is named after names[n - 1]. */
  names: string[] = [];

  /** Join or remove bots (newest first) until there are exactly `target`. */
  sync(w: World, rules: GameRules, target: number): void {
    while (this.ids.length > target) leavePlayer(w, rules, this.ids.pop()!);
    while (this.ids.length < target) {
      const n = this.ids.length + 1;
      const id = `${BOT_PREFIX}${n}`;
      this.ids.push(id);
      joinPlayer(w, rules, id, botLabel(this.names[n - 1], n));
    }
  }

  /** New top names: bots already in the world are renamed in place (clients draw names from w.names). */
  rename(w: World, names: string[]): void {
    this.names = names;
    this.ids.forEach((id, i) => { if (id in w.names) w.names[id] = botLabel(names[i], i + 1); });
  }

  /** This tick's input for every bot (zero input while `idle`, e.g. a draining room). */
  inputs(w: World, idle = false): Record<string, Input> {
    const out: Record<string, Input> = {};
    this.ids.forEach((id, i) => { out[id] = idle ? { dx: 0, dy: 0, action: false } : botInput(w, id, i + 1); });
    return out;
  }
}
