import { describe, it, expect } from "vitest";
import type { Entity } from "@tcg/shared";
import { detectKills } from "./assets.js";

function ent(id: string, kind: string, x: number, y: number, r: number): Entity {
  return { id, kind, x, y, vx: 0, vy: 0, r, data: {} };
}
function rec(...es: Entity[]): Record<string, Entity> {
  return Object.fromEntries(es.map((e) => [e.id, e]));
}

describe("detectKills", () => {
  it("reports the killer and victim when a big entity eats a smaller one", () => {
    const prev = rec(ent("big", "player", 500, 500, 40), ent("small", "bot", 520, 500, 20));
    const next = rec(ent("big", "player", 505, 500, 45), ent("small", "bot", 100, 100, 8));
    expect(detectKills(prev, next)).toEqual([{ killerId: "big", victimId: "small" }]);
  });

  it("reports nothing when everyone just moves a bit", () => {
    const prev = rec(ent("a", "player", 500, 500, 20), ent("b", "bot", 900, 900, 20));
    const next = rec(ent("a", "player", 505, 502, 20), ent("b", "bot", 897, 903, 20));
    expect(detectKills(prev, next)).toEqual([]);
  });

  it("reports nothing when a victim shrinks and jumps but nobody grew", () => {
    const prev = rec(ent("a", "player", 500, 500, 30), ent("b", "bot", 900, 900, 20));
    const next = rec(ent("a", "player", 500, 500, 30), ent("b", "bot", 100, 100, 8));
    expect(detectKills(prev, next)).toEqual([]);
  });
});
