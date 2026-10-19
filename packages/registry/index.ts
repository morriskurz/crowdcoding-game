// @tcg/games: every game in packages/games/*, keyed by slug, plus which one is this week's.
// Frozen owner infra. The list itself is generated (games.gen.ts, scripts/registry.mjs), so the
// weekly bootstrap only adds a game directory and never edits this package.
import type { Entity, GameRules } from "@tcg/shared";
import type { GameAssets } from "@tcg/kit";
import { CURRENT_SLUG as GEN_CURRENT, GAME_LIST } from "./games.gen.js";

/** What packages/games/<slug>/index.ts must export. */
export interface GameModule {
  rules: GameRules;
  config: Readonly<Record<string, unknown>>;
  assets: GameAssets<Entity>;
}

export interface Game extends GameModule {
  slug: string;
  title: string;
  /** ISO time from package.json `tcg.created`; the newest game is current. */
  created: string;
}

// Typed against GameModule here, so a game that exports the wrong shape fails `pnpm -r check`.
const list: readonly { slug: string; title: string; created: string; module: GameModule }[] = GAME_LIST;

export const GAMES: Readonly<Record<string, Game>> = Object.freeze(
  Object.fromEntries(list.map(({ slug, title, created, module: m }) => [slug, { slug, title, created, rules: m.rules, config: m.config, assets: m.assets }])),
);

export const CURRENT_SLUG: string = GEN_CURRENT;
if (!GAMES[CURRENT_SLUG]) throw new Error(`@tcg/games: current game "${CURRENT_SLUG}" missing; run node scripts/registry.mjs`);

/** Room the default URL (no slug) plays: the current game. */
export const MAIN_ROOM = "main";

export interface RoomGame {
  /** Durable Object name to use. */
  room: string;
  /** Game whose rules the room runs. */
  slug: string;
  /** true for every game but the current one: old weeks stay playable, flagged as archive. */
  archived: boolean;
}

/**
 * Room name -> game. A room named after an archived game's slug runs that game; the current game's
 * slug is an alias of "main" (one live room); any other name (main, test rooms) runs the current game.
 */
export function gameForRoom(room: string, current: string = CURRENT_SLUG, slugs: readonly string[] = Object.keys(GAMES)): RoomGame {
  if (room === current) return { room: MAIN_ROOM, slug: current, archived: false };
  if (slugs.includes(room)) return { room, slug: room, archived: true };
  return { room, slug: current, archived: false };
}
