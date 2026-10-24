import { describe, it, expect } from "vitest";
import { createWorld, joinPlayer, runTick, bodies, get, spawn } from "@tcg/shared";
import { blowbackCheck, botEatCheck, botFightCheck, botStep, eatCheck, getShape, magnetCheck, rules, shapeCheck, shapeHuntCheck, spawnPellet, GROWTH_PER_PELLET } from "./rules.js";
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

  it("blowback: bigger movers shove harder, stationary and distant do nothing", () => {
    const shove = (r: number, moving: boolean, gap = 0) => {
      const w = createWorld();
      const a = spawn(w, { kind: "bot", x: 300, y: 300, r });
      if (moving) a.vx = 1;
      const b = spawn(w, { kind: "bot", x: 300 + r + 3 + gap, y: 300, r: 5 });
      const x0 = b.x;
      blowbackCheck(w);
      expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
      return { dx: b.x - x0, dy: b.y - 300, ax: a.x };
    };
    const small = shove(10, true).dx;
    const big = shove(40, true).dx;
    expect(small).toBeCloseTo(Math.min(config.blowbackMax, config.blowbackStrength * 10), 5);
    expect(big).toBeGreaterThan(small);
    expect(shove(40, false).dx).toBe(0);
    expect(shove(40, true, 50).dx).toBe(0);
  });

  it("blowback: zero distance gives finite push and stays in arena", () => {
    const w = createWorld();
    const a = spawn(w, { kind: "bot", x: 300, y: 300, r: 20 });
    a.vy = 2;
    const b = spawn(w, { kind: "player", x: 300, y: 300, r: 20 });
    blowbackCheck(w);
    expect(b.x).toBeGreaterThan(300);
    expect(Number.isNaN(b.y)).toBe(false);
    const w2 = createWorld();
    const c = spawn(w2, { kind: "bot", x: 20, y: 300, r: 20 });
    c.vx = 1;
    const e = spawn(w2, { kind: "bot", x: 5, y: 300, r: 5 });
    blowbackCheck(w2);
    expect(e.x).toBeGreaterThanOrEqual(5);
    expect(e.x).toBeLessThanOrEqual(config.bounds - 5);
  });

  it("shapes: max size respawns small as square or triangle, again when reshaped", () => {
    const w = createWorld(5);
    joinPlayer(w, rules, "a", "alice");
    const p = get(w, "a")!;
    expect(getShape(p)).toBe("circle");
    p.x = 400; p.y = 400; p.r = config.maxSize;
    shapeCheck(w);
    expect(p.x).toBe(100);
    expect(p.r).toBe(config.startSize);
    expect(["square", "triangle"]).toContain(getShape(p));
    p.r = config.maxSize + 1;
    shapeCheck(w);
    expect(p.r).toBe(config.startSize);
    expect(["square", "triangle"]).toContain(getShape(p));
  });

  it("shapes: bots at max size become shapes, move by shape speed, lose shape when eaten", () => {
    const w = createWorld(5);
    const bot = spawn(w, { kind: "bot", x: 400, y: 400, r: config.maxSize });
    shapeCheck(w);
    expect(bot.r).toBe(config.startSize);
    const shape = getShape(bot);
    expect(["square", "triangle"]).toContain(shape);
    spawn(w, { kind: "pellet", x: bot.x + 50, y: bot.y, r: 2 });
    botStep(w);
    const mult = shape === "square" ? config.squareSpeedMult : config.triangleSpeedMult;
    expect(Math.hypot(bot.vx, bot.vy)).toBeCloseTo(Math.min(config.botSpeed * mult, 50), 5);
    joinPlayer(w, rules, "a", "alice");
    const p = get(w, "a")!;
    p.x = bot.x; p.y = bot.y; p.r = bot.r * 2;
    botFightCheck(w);
    expect(getShape(bot)).toBe("circle");
  });

  it("shapes: speed and pellet growth depend on shape", () => {
    const move = (shape?: string) => {
      const w = createWorld();
      joinPlayer(w, rules, "a", "alice");
      const p = get(w, "a")!;
      if (shape) (p.data as any).shape = shape;
      runTick(w, rules, { a: { dx: 1, dy: 0, action: false } });
      return p.x - 100;
    };
    expect(move()).toBeCloseTo(config.speed, 5);
    expect(move("square")).toBeCloseTo(config.speed * config.squareSpeedMult, 5);
    expect(move("triangle")).toBeCloseTo(config.speed * config.triangleSpeedMult, 5);
    const grow = (shape: string) => {
      const w = createWorld();
      joinPlayer(w, rules, "a", "alice");
      const p = get(w, "a")!;
      (p.data as any).shape = shape;
      p.x = 10; p.y = 10;
      spawn(w, { kind: "pellet", x: 10, y: 10, r: 2 });
      eatCheck(w);
      return p.r - config.startSize;
    };
    expect(grow("square")).toBeCloseTo(GROWTH_PER_PELLET * config.squareGrowthMult, 5);
    expect(grow("triangle")).toBeCloseTo(GROWTH_PER_PELLET * config.triangleGrowthMult, 5);
  });

  it("shape hunt: bigger shaped player eats a small circle player", () => {
    const w = createWorld();
    joinPlayer(w, rules, "a", "alice");
    joinPlayer(w, rules, "b", "bob");
    const s = get(w, "a")!;
    const c = get(w, "b")!;
    (s.data as any).shape = "square";
    s.x = 300; s.y = 300; s.r = 20;
    c.x = 300; c.y = 300; c.r = 10;
    shapeHuntCheck(w);
    expect(s.r).toBeCloseTo(25, 5);
    expect(c.x).toBe(100);
    expect(c.r).toBe(config.startSize);
    expect(getShape(s)).toBe("square");
  });

  it("shape hunt: bigger circle player destroys a small shaped player and gets a bounty", () => {
    const w = createWorld();
    joinPlayer(w, rules, "a", "alice");
    joinPlayer(w, rules, "b", "bob");
    const s = get(w, "a")!;
    const c = get(w, "b")!;
    (s.data as any).shape = "triangle";
    s.x = 300; s.y = 300; s.r = 10;
    c.x = 300; c.y = 300; c.r = 20;
    shapeHuntCheck(w);
    expect(c.r).toBeCloseTo(20 + 10 * config.shapeBounty, 5);
    expect(s.x).toBe(100);
    expect(s.r).toBe(config.startSize);
    expect(getShape(s)).toBe("circle");
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
