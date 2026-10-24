import { describe, it, expect } from "vitest";
import { createWorld, runTick } from "@tcg/shared";
import { GAMES, CURRENT_SLUG } from "@tcg/games";
import { BOT_FILL, Bots, CURRENT_FILL, botInput, botTarget, isBotId } from "./bots.js";

const rules = GAMES[CURRENT_SLUG].rules;

function world(seed = 7) {
  const w = createWorld(seed);
  rules.init?.(w);
  return w;
}

describe("bots", () => {
  it("fill a room only while someone is connected", () => {
    expect(botTarget(true, 0)).toBe(0);
    expect(botTarget(true, 1)).toBe(BOT_FILL - 1);
    expect(botTarget(true, BOT_FILL + 3)).toBe(0);
    expect(botTarget(false, 1)).toBe(CURRENT_FILL - 1); // the current game gets a few, so the stream is never empty
    expect(botTarget(true, 0, 1)).toBe(BOT_FILL); // a spectator alone watches a full archive room
    expect(botTarget(false, 0, 1)).toBe(CURRENT_FILL);
    expect(botTarget(false, CURRENT_FILL + 1)).toBe(0);
    expect(botTarget(false, 0, 0)).toBe(0);
  });

  it("join and leave through the game's own rules, ids bot:1..bot:k", () => {
    const w = world();
    const b = new Bots();
    b.sync(w, rules, 3);
    expect(b.ids).toEqual(["bot:1", "bot:2", "bot:3"]);
    expect(Object.keys(w.names)).toEqual(b.ids);
    expect(b.ids.every((id) => w.entities[id]?.kind === "player")).toBe(true);
    b.sync(w, rules, 1);
    expect(b.ids).toEqual(["bot:1"]);
    expect(w.entities["bot:2"]).toBeUndefined();
    b.sync(w, rules, 0);
    expect(Object.keys(w.names)).toEqual([]);
    expect(isBotId("bot:1")).toBe(true);
    expect(isBotId("3f2a-uuid")).toBe(false);
  });

  it("are deterministic and actually play (move, eat)", () => {
    const play = () => {
      const w = world(42);
      const b = new Bots();
      b.sync(w, rules, BOT_FILL);
      const r0 = b.ids.map((id) => w.entities[id].r);
      for (let i = 0; i < 300; i++) runTick(w, rules, b.inputs(w));
      return { w, r0, b };
    };
    const a = play();
    const c = play();
    expect(JSON.stringify(a.w)).toBe(JSON.stringify(c.w));
    const moved = a.b.ids.filter((id) => a.w.entities[id].x !== 100 || a.w.entities[id].y !== 100);
    expect(moved.length).toBe(BOT_FILL);
    const grew = a.b.ids.filter((id, i) => a.w.entities[id].r > a.r0[i]);
    expect(grew.length).toBeGreaterThan(0);
  });

  it("inputs are valid wire inputs; idle bots stand still", () => {
    const w = world();
    const b = new Bots();
    b.sync(w, rules, 2);
    for (const inp of Object.values(b.inputs(w))) {
      expect(Math.abs(inp.dx)).toBeLessThanOrEqual(1);
      expect(Math.abs(inp.dy)).toBeLessThanOrEqual(1);
    }
    expect(Object.values(b.inputs(w, true))).toEqual([{ dx: 0, dy: 0, action: false }, { dx: 0, dy: 0, action: false }]);
    // with nothing to chase it still wanders
    const empty = createWorld(1);
    b.ids = [];
    b.sync(empty, rules, 1);
    const seen = new Set<string>();
    for (let t = 0; t < 120; t++) { empty.tick = t; seen.add(JSON.stringify(botInput(empty, "bot:1", 1))); }
    expect(seen.size).toBeGreaterThan(1);
  });
});
