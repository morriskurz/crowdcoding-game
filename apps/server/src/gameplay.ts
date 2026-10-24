// Gameplay health for /health: what the world looks like, so a shipped feature that breaks the game
// (entities growing without bound, leaving the arena) is visible. Nothing rolls back on it (owner
// decision 2026-10-24: fail forward); the bot hands the issues to the next house feature to fix.
import type { GameRules, World } from "@tcg/shared";

export interface KindStats { n: number; maxR: number }
export interface Gameplay {
  kinds: Record<string, KindStats>;
  arena: { w: number; h: number } | null;
  /** Plain-language problems, empty when none were found. */
  issues: string[];
}

/** An entity whose radius exceeds this share of the arena's short side counts as oversized. */
export const OVERSIZE_SHARE = 0.25;
/** Tolerance before an entity centre counts as outside the arena. */
const EDGE = 1;

export function gameplay(w: World, rules: GameRules): Gameplay {
  const kinds: Record<string, KindStats> = {};
  const arena = rules.arena ?? null;
  const outside: Record<string, number> = {};
  const oversize: Record<string, number> = {};
  for (const e of Object.values(w.entities)) {
    const kind = e.id in w.names ? "player" : e.kind;
    const k = (kinds[kind] ??= { n: 0, maxR: 0 });
    k.n++;
    k.maxR = Math.max(k.maxR, Math.round(e.r));
    if (!arena) continue;
    if (e.x < -EDGE || e.y < -EDGE || e.x > arena.w + EDGE || e.y > arena.h + EDGE) outside[kind] = (outside[kind] ?? 0) + 1;
    if (e.r > OVERSIZE_SHARE * Math.min(arena.w, arena.h)) oversize[kind] = (oversize[kind] ?? 0) + 1;
  }
  const issues: string[] = [];
  if (arena) {
    for (const [kind, n] of Object.entries(oversize)) {
      issues.push(`${n} ${kind} entit${n === 1 ? "y is" : "ies are"} oversized (radius up to ${kinds[kind].maxR} in a ${arena.w}x${arena.h} arena)`);
    }
    for (const [kind, n] of Object.entries(outside)) issues.push(`${n} ${kind} entit${n === 1 ? "y is" : "ies are"} outside the arena`);
  }
  return { kinds, arena, issues };
}
