import { describe, it, expect } from "vitest";
import { createWorld, spawn, bodies, runTick, random, type GameRules, type World } from "../index.js";
import { circleBoxContact, circlesOverlap, confine, moveBody, separate, stepPhysics, type Box } from "./physics.js";

const floor: Box = { x: 0, y: 100, w: 200, h: 20 };

describe("collision", () => {
  it("lands on a box: stops, sits on top, ground=true", () => {
    const w = createWorld();
    const e = spawn(w, { kind: "b", x: 50, y: 80, r: 10, vy: 5 });
    for (let i = 0; i < 20; i++) moveBody(e, { gravity: 1, solids: [floor] });
    expect(e.y).toBeCloseTo(90, 9);
    expect(e.vy).toBe(0);
    expect(e.ground).toBe(true);
  });

  it("hits a wall side: horizontal velocity removed, not ground", () => {
    const w = createWorld();
    const wall: Box = { x: 100, y: 0, w: 20, h: 200 };
    const e = spawn(w, { kind: "b", x: 80, y: 50, r: 10, vx: 15 });
    moveBody(e, { solids: [wall] });
    expect(e.x).toBeCloseTo(90, 9);
    expect(e.vx).toBe(0);
    expect(e.ground).toBe(false);
  });

  it("fast body does not tunnel through a thin platform", () => {
    const w = createWorld();
    const thin: Box = { x: 0, y: 100, w: 200, h: 2 };
    const e = spawn(w, { kind: "b", x: 50, y: 0, r: 5, vy: 300 });
    moveBody(e, { solids: [thin] });
    expect(e.y).toBeCloseTo(95, 9);
    expect(e.ground).toBe(true);
  });

  it("center inside a box is pushed out through the nearest face", () => {
    const w = createWorld();
    const e = spawn(w, { kind: "b", x: 50, y: 103, r: 4 });
    const c = circleBoxContact(e, floor)!;
    expect(c).toEqual({ nx: 0, ny: -1, depth: 7 });
  });

  it("corner contact gives a diagonal normal", () => {
    const w = createWorld();
    const e = spawn(w, { kind: "b", x: -3, y: 97, r: 5 });
    const c = circleBoxContact(e, floor)!;
    expect(c.nx).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(c.ny).toBeCloseTo(-Math.SQRT1_2, 9);
    expect(circleBoxContact(spawn(w, { kind: "b", x: -10, y: 90, r: 5 }), floor)).toBeNull();
  });

  it("bounce reflects velocity", () => {
    const w = createWorld();
    const e = spawn(w, { kind: "b", x: 50, y: 85, r: 10, vy: 10 });
    moveBody(e, { solids: [floor], bounce: 1 });
    expect(e.vy).toBe(-10);
  });

  it("confine keeps a circle inside and reports the floor", () => {
    const w = createWorld();
    const bounds: Box = { x: 0, y: 0, w: 100, h: 100 };
    const e = spawn(w, { kind: "b", x: 99, y: 120, r: 5, vx: 3, vy: 3 });
    expect(confine(e, bounds)).toBe(true);
    expect([e.x, e.y, e.vx, e.vy]).toEqual([95, 95, -0, -0]);
    expect(e.ground).toBe(true);
  });

  it("separate pushes circles apart, heavier moves less, kills approach speed", () => {
    const w = createWorld();
    const big = spawn(w, { kind: "b", x: 0, y: 0, r: 20, vx: 1 });
    const small = spawn(w, { kind: "b", x: 25, y: 0, r: 10, vx: -4 });
    expect(separate(big, small)).toBe(true);
    expect(circlesOverlap(big, small)).toBe(false);
    expect(small.x - big.x).toBeCloseTo(30, 9);
    expect(Math.abs(big.x)).toBeLessThan(Math.abs(small.x - 25));
    expect(small.vx - big.vx).toBeGreaterThanOrEqual(-1e-12);
  });

  it("separate handles exact overlap deterministically", () => {
    const w = createWorld();
    const a = spawn(w, { kind: "b", x: 10, y: 10, r: 5 });
    const b = spawn(w, { kind: "b", x: 10, y: 10, r: 5 });
    separate(a, b);
    expect([a.x, a.y, b.x, b.y]).toEqual([5, 10, 15, 10]);
  });

  it("stack of bodies on a floor settles without overlap", () => {
    const w = createWorld();
    for (let i = 0; i < 5; i++) spawn(w, { kind: "b", x: 100 + i * 3, y: 20 + i * 15, r: 8 });
    const list = bodies(w);
    for (let t = 0; t < 200; t++) stepPhysics(list, { gravity: 0.5, solids: [floor], bounds: { x: 0, y: 0, w: 200, h: 200 } });
    for (const e of list) expect(e.y).toBeLessThanOrEqual(92 + 1e-9);
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const d = Math.hypot(list[i].x - list[j].x, list[i].y - list[j].y);
      expect(d).toBeGreaterThan(list[i].r + list[j].r - 0.5);
    }
  });
});

// A platformer-ish testbed exercising every physics path plus RNG spawns/despawns.
const testbed: GameRules = {
  init(w) {
    for (let i = 0; i < 10; i++) spawn(w, { kind: "crate", x: random(w) * 400, y: random(w) * 100, r: 4 + random(w) * 6 });
  },
  join(w, id) { spawn(w, { id, kind: "player", x: 50, y: 50, r: 10 }); },
  step(w, inputs) {
    for (const p of bodies(w, "player")) {
      const inp = inputs[p.id];
      p.vx = (inp?.dx ?? 0) * 4;
      if (inp?.action && p.ground) p.vy = -12;
    }
    stepPhysics(bodies(w), {
      gravity: 0.6, drag: 0.01, maxSpeed: 20, bounce: 0.2,
      bounds: { x: 0, y: 0, w: 400, h: 300 },
      solids: [{ x: 0, y: 250, w: 400, h: 50 }, { x: 120, y: 180, w: 80, h: 8 }, { x: 260, y: 120, w: 60, h: 8 }],
    });
    if (w.tick % 17 === 0) spawn(w, { kind: "crate", x: random(w) * 400, y: 0, r: 5 });
    const crates = bodies(w, "crate");
    if (crates.length > 20) delete w.entities[crates[0].id];
  },
};

function scriptedInputs(w: World, ids: string[]) {
  // Inputs drawn from the world RNG keep the script itself deterministic.
  const out: Record<string, { dx: number; dy: number; action: boolean }> = {};
  for (const id of ids) out[id] = { dx: Math.floor(random(w) * 3) - 1, dy: 0, action: random(w) < 0.1 };
  return out;
}

function simulate(seed: number, ticks: number, w: World = createWorld(seed), fresh = true): World {
  if (fresh) {
    testbed.init!(w);
    testbed.join(w, "p1", "a");
    testbed.join(w, "p2", "b");
  }
  for (let t = 0; t < ticks; t++) runTick(w, testbed, scriptedInputs(w, ["p1", "p2"]));
  return w;
}

describe("determinism", () => {
  it("same seed + inputs => identical state after N ticks", () => {
    const a = JSON.stringify(simulate(1234, 1000));
    const b = JSON.stringify(simulate(1234, 1000));
    expect(a).toBe(b);
  });

  it("different seed => different state", () => {
    expect(JSON.stringify(simulate(1, 300))).not.toBe(JSON.stringify(simulate(2, 300)));
  });

  it("resuming from a JSON snapshot matches the uninterrupted run (client prediction)", () => {
    const full = simulate(99, 600);
    const half = simulate(99, 300);
    const restored = JSON.parse(JSON.stringify(half)) as World;
    simulate(99, 300, restored, false);
    expect(JSON.stringify(restored)).toBe(JSON.stringify(full));
  });

  it("stays finite and in bounds", () => {
    const w = simulate(7, 2000);
    for (const e of bodies(w)) {
      expect(Number.isFinite(e.x) && Number.isFinite(e.y)).toBe(true);
      expect(e.x).toBeGreaterThanOrEqual(e.r - 1e-9);
      expect(e.x).toBeLessThanOrEqual(400 - e.r + 1e-9);
    }
  });
});
