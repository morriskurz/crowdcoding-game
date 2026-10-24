import { describe, it, expect } from "vitest";
import { createWorld, joinPlayer, runTick, bodies, get, spawn } from "@tcg/shared";
import { botEatCheck, botFightCheck, botStep, eatCheck, magnetCheck, rules, spawnPellet, GROWTH_PER_PELLET } from "./rules.js";
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

  it("bots exist after init", () => {
    const w = world();
    expect(bodies(w, "bot")).toHaveLength(config.botCount);
  });

  it("a bot moves toward its nearest pellet", () => {
    const w = createWorld();
    const bot = spawn(w, { kind: "bot", x: 400, y: 400, r: config.startSize });
    spawn(w, { kind: "pellet", x: 500, y: 400, r: 2 });
    botStep(w);
    expect(bot.x).toBeCloseTo(400 + config.botSpeed, 5);
    expect(bot.y).toBeCloseTo(400, 5);
  });

  it("a bot eats a pellet and grows", () => {
    const w = createWorld();
    const bot = spawn(w, { kind: "bot", x: 400, y: 400, r: config.startSize });
    spawn(w, { kind: "pellet", x: 400, y: 400, r: 2 });
    botEatCheck(w);
    expect(bodies(w, "pellet")).toHaveLength(0);
    expect(bot.r).toBeCloseTo(config.startSize + GROWTH_PER_PELLET, 5);
  });

  it("a big player eats a small bot", () => {
    const w = createWorld();
    joinPlayer(w, rules, "a", "alice");
    const p = get(w, "a")!;
    p.r = 20;
    const bot = spawn(w, { kind: "bot", x: p.x, y: p.y, r: 10 });
    botFightCheck(w);
    expect(p.r).toBeCloseTo(25, 5);
    expect(bot.r).toBe(config.startSize);
    expect(bot.x !== p.x || bot.y !== p.y).toBe(true);
  });

  it("a big bot resets an overlapped small player", () => {
    const w = createWorld();
    joinPlayer(w, rules, "a", "alice");
    const p = get(w, "a")!;
    p.x = 300; p.y = 300;
    const bot = spawn(w, { kind: "bot", x: 300, y: 300, r: 30 });
    botFightCheck(w);
    expect(p.x).toBe(100);
    expect(p.r).toBe(config.startSize);
    expect(bot.r).toBeCloseTo(30 + config.startSize * 0.5, 5);
    expect(get(w, "a")).toBeDefined();
  });

  it("pellet types grow by type and are recorded", () => {
    const w = createWorld();
    joinPlayer(w, rules, "a", "alice");
    const p = get(w, "a")!;
    p.x = 10; p.y = 10;
    spawn(w, { kind: "pellet", x: 10, y: 10, r: 2, data: { type: "spiked" } });
    eatCheck(w);
    expect(p.r).toBeCloseTo(config.startSize + config.spikedGrowth, 5);
    spawn(w, { kind: "pellet", x: 10, y: 10, r: 2, data: { type: "sweet" } });
    eatCheck(w);
    expect(p.r).toBeCloseTo(config.startSize + config.spikedGrowth + config.sweetGrowth, 5);
    expect((p.data as any).eaten).toEqual({ normal: 0, spiked: 1, sweet: 1 });
  });

  it("bots grow by pellet type", () => {
    const w = createWorld();
    const bot = spawn(w, { kind: "bot", x: 400, y: 400, r: config.startSize });
    spawn(w, { kind: "pellet", x: 400, y: 400, r: 2, data: { type: "sweet" } });
    botEatCheck(w);
    expect(bot.r).toBeCloseTo(config.startSize + config.sweetGrowth, 5);
  });

  it("specialist bonus applies once a type dominates", () => {
    const w = createWorld();
    joinPlayer(w, rules, "a", "alice");
    const p = get(w, "a")!;
    p.x = 10; p.y = 10;
    const grow: number[] = [];
    for (let i = 0; i < config.specialistMin; i++) {
      spawn(w, { kind: "pellet", x: 10, y: 10, r: 2, data: { type: "sweet" } });
      const before = p.r;
      eatCheck(w);
      grow.push(p.r - before);
    }
    expect(grow[0]).toBeCloseTo(config.sweetGrowth, 5);
    expect(grow[config.specialistMin - 1]).toBeCloseTo(config.sweetGrowth * (1 + config.specialistBonus), 5);
  });

  it("spawned pellets carry a valid type", () => {
    const w = createWorld(3);
    for (let i = 0; i < 100; i++) spawnPellet(w);
    const types = new Set(bodies(w, "pellet").map((q) => (q.data as any).type));
    for (const t of types) expect(["normal", "spiked", "sweet"]).toContain(t);
    expect(types.size).toBe(3);
  });

  it("is deterministic with bots", () => {
    const run = () => {
      const w = world(9);
      for (let t = 0; t < 200; t++) runTick(w, rules, { a: { dx: 1, dy: t % 20 < 10 ? 1 : -1, action: false } });
      expect(bodies(w, "bot")).toHaveLength(config.botCount);
      return JSON.stringify(w);
    };
    expect(run()).toBe(run());
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
