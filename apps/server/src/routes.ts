// URL -> room and URL -> static asset, for several games side by side (packages/registry).
//   /                     host page, current game        /parties/<party>/main         current game's live room
//   /game                 current game's sandboxed page  /parties/<party>/<old slug>   that archived game's room
//   /<slug>               host page for that game        /parties/<party>/<other>      current game, room <other>
//   /<slug>/game          that game's sandboxed page     /health?room=<slug>           same mapping
// Pure (no partyserver import) so it is unit-testable in node.
import { CURRENT_SLUG, GAMES, gameForRoom, type RoomGame } from "@tcg/games";

export function cleanRoom(raw: string | null | undefined): string {
  return (raw ?? "main").replace(/[^a-z0-9-_]/gi, "").slice(0, 32) || "main";
}

/** Room for a cleaned name: the current game's slug is an alias of "main". */
export function resolveRoom(raw: string | null | undefined, current = CURRENT_SLUG, slugs: readonly string[] = Object.keys(GAMES)): RoomGame {
  return gameForRoom(cleanRoom(raw), current, slugs);
}

export function roomFromPath(pathname: string, current = CURRENT_SLUG, slugs: readonly string[] = Object.keys(GAMES)): RoomGame | null {
  const m = pathname.match(/^\/parties\/[^/]+\/([^/]+)/);
  return m ? resolveRoom(m[1], current, slugs) : null;
}

/**
 * Asset path to serve instead of `pathname`, or null to serve it as is. Built pages:
 * index.html (host, any game) and games/<slug>.html (one sandboxed game page per game).
 * Workers Static Assets serve games/<slug>.html at /games/<slug>.
 */
export function assetPath(pathname: string, current = CURRENT_SLUG, slugs: readonly string[] = Object.keys(GAMES)): string | null {
  if (/^\/game(\.html)?\/?$/.test(pathname)) return `/games/${current}`;
  const m = pathname.match(/^\/([a-z0-9][a-z0-9-]{0,39})(\/game)?\/?$/);
  if (!m || !slugs.includes(m[1])) return null;
  return m[2] ? `/games/${m[1]}` : "/";
}
