import { describe, it, expect } from "vitest";
import { createWorld, spawn, despawn, bodies, joinPlayer, leavePlayer, runTick, random, randomInt, snapMessage, type GameRules } from "../index.js";

const rules: GameRules = {
  join(w, id) { spawn(w, { id, kind: "player", x: 1, y: 2 }); },
  step(w, inputs) { for (const p of bodies(w, "player")) p.x += inputs[p.id]?.dx ?? 0; },
};

describe("world", () => {
  it("spawns with sequential ids and defaults", () => {
    const w = createWorld();
    const a = spawn(w, { kind: "pellet" });
    const b = spawn(w, { kind: "pellet", x: 5, data: { hp: 3 } });
    expect([a.id, b.id]).toEqual(["e1", "e2"]);
    expect(a).toEqual({ id: "e1", kind: "pellet", x: 0, y: 0, vx: 0, vy: 0, r: 8, data: {} });
    expect(b.data).toEqual({ hp: 3 });
    despawn(w, "e1");
    expect(bodies(w).map((e) => e.id)).toEqual(["e2"]);
  });

  it("join/leave/tick through game rules", () => {
    const w = createWorld();
    joinPlayer(w, rules, "p", "a-very-long-name-over-16");
    expect(w.names.p).toBe("a-very-long-name");
    runTick(w, rules, { p: { dx: 1, dy: 0, action: false } });
    expect(w.tick).toBe(1);
    expect(w.entities.p.x).toBe(2);
    leavePlayer(w, rules, "p");
    expect(w.entities.p).toBeUndefined();
    expect(w.names.p).toBeUndefined();
  });

  it("rng is seeded, in range, and lives in the world", () => {
    const a = createWorld(5), b = createWorld(5);
    const xs = Array.from({ length: 1000 }, () => random(a));
    expect(xs).toEqual(Array.from({ length: 1000 }, () => random(b)));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(a.rng).toBe(b.rng);
    const n = createWorld(5);
    expect(new Set(Array.from({ length: 500 }, () => randomInt(n, 4)))).toEqual(new Set([0, 1, 2, 3]));
  });

  it("snapshot carries entities and the v2 legacy fields", () => {
    const w = createWorld();
    joinPlayer(w, rules, "p", "al");
    spawn(w, { kind: "pellet", x: 3, y: 4, r: 2 });
    const s = snapMessage(w, "v9", false);
    expect(s.entities).toBe(w.entities);
    expect(s.players.p).toEqual({ id: "p", name: "al", x: 1, y: 2, dx: 0, dy: 0, size: 8, alive: true });
    expect(s.pellets).toEqual([{ x: 3, y: 4 }]);
  });
});
