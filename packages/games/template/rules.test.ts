import { describe, it, expect } from "vitest";
import { createWorld, joinPlayer, runTick, bodies, get, spawn } from "@tcg/shared";
import { eatCheck, magnetCheck, rules, GROWTH_PER_PELLET } from "./rules.js";
import { config } from "./config.js";

function world(seed = 7) {
  const w = createWorld(seed);
  rules.init!(w);
  joinPlayer(w, rules, "a", "alice");
  return w;
}

describe("template agar", () => {
  it("moves player by speed per tick with clamped input", () => {
    const w = world();
    runTick(w, rules, { a: { dx: 1, dy: 0, action: false } });
    expect(get(w, "a")!.x).toBe(100 + config.speed);
    expect(w.tick).toBe(1);
  });

  it("keeps player inside the arena", () => {
    const w = world();
    get(w, "a")!.x = 2;
    runTick(w, rules, { a: { dx: -1, dy: 0, action: false } });
    expect(get(w, "a")!.x).toBe(config.startSize);
  });

  it("feature #1: grows 1.0 per pellet", () => {
    const w = createWorld();
    joinPlayer(w, rules, "a", "alice");
    const p = get(w, "a")!;
    p.x = 10; p.y = 10;
    spawn(w, { kind: "pellet", x: 10, y: 10, r: 2 });
    eatCheck(w);
    expect(bodies(w, "pellet")).toHaveLength(0);
    expect(p.r).toBeCloseTo(config.startSize + GROWTH_PER_PELLET, 5);
  });

  it("feature #2: pulls nearby pellets toward player", () => {
    const w = createWorld();
    joinPlayer(w, rules, "a", "alice");
    const pel = spawn(w, { kind: "pellet", x: 150, y: 100, r: 2 });
    magnetCheck(w);
    expect(pel.x).toBeLessThan(150);
  });

  it("restocks pellets to config.pellets", () => {
    const w = world();
    const p = get(w, "a")!;
    const target = bodies(w, "pellet")[0];
    p.x = target.x; p.y = target.y;
    runTick(w, rules, { a: { dx: 0, dy: 0, action: false } });
    expect(bodies(w, "pellet")).toHaveLength(config.pellets);
  });

  it("is deterministic for the same seed and inputs", () => {
    const run = () => {
      const w = world(42);
      for (let t = 0; t < 300; t++) runTick(w, rules, { a: { dx: t % 50 < 25 ? 1 : -1, dy: t % 30 < 15 ? 1 : -1, action: false } });
      return JSON.stringify(w);
    };
    expect(run()).toBe(run());
  });
});
