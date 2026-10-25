import { describe, it, expect } from "vitest";
import { createWorld, joinPlayer, runTick, bodies, get, type Entity, type Input, type World } from "@tcg/shared";
import { rules, SECTION_TYPES, MAX_RISE, airTicks, buildTower, maxGap, platformTop, typesFor, type PlatformData, type PlayerData, type RoundData } from "./rules.js";
import { config } from "./config.js";

const idle = { dx: 0, dy: 0, action: false };
const jump = { dx: 0, dy: 0, action: true };
const startY = config.floorY - config.playerR;

function world(seed = 7) {
  const w = createWorld(seed);
  rules.init!(w);
  joinPlayer(w, rules, "a", "alice");
  return w;
}
const pl = (w: World, id = "a") => get<PlayerData>(w, id)!;
const rd = (w: World) => get<RoundData>(w, "round")!.data;
const platforms = (w: World) => bodies<PlatformData>(w, "platform");
const safe = (w: World) => platforms(w).filter((q) => q.data.type !== "kill");

/** Puts the player on a fresh flat ground far from any platform and returns the world. */
function flat(seed = 7) {
  const w = world(seed);
  for (const q of platforms(w)) if (q.data.type !== "ground") delete w.entities[q.id];
  return w;
}

/** Runs inputs from the ground and returns the y path. */
function path(w: World, inputs: Input[], extra = 0): number[] {
  const out: number[] = [];
  for (let t = 0; t < inputs.length + extra; t++) {
    runTick(w, rules, { a: inputs[t] ?? idle });
    out.push(pl(w).y);
  }
  return out;
}

describe("tower climb: movement feel", () => {
  it("stands on the ground under gravity", () => {
    const w = flat();
    pl(w).y = startY - 60;
    path(w, [], 30);
    expect(pl(w).y).toBe(startY);
    expect(pl(w).ground).toBe(true);
  });

  it("a full jump reaches 4 to 5 player heights in about one second (genre feel targets)", () => {
    expect(MAX_RISE).toBeGreaterThan(4 * 2 * config.playerR);
    expect(MAX_RISE).toBeLessThan(5 * 2 * config.playerR);
    const w = flat();
    const ys = path(w, Array(40).fill(jump));
    const air = ys.findIndex((y, i) => i > 0 && y === startY) + 1;
    expect(air / config.tickHz).toBeGreaterThan(0.9);
    expect(air / config.tickHz).toBeLessThan(1.3);
    expect(startY - Math.min(...ys)).toBeCloseTo(MAX_RISE, 5);
  });

  it("falls faster than it rises: the arc is not symmetric", () => {
    const w = flat();
    path(w, Array(40).fill(jump));
    const ws = flat();
    const ys = path(ws, Array(40).fill(jump));
    const apex = ys.indexOf(Math.min(...ys));
    const land = ys.findIndex((y, i) => i > apex && y === startY);
    expect(land - apex).toBeLessThan(apex + 1);
    // gravity on the way down is stronger than on the way up
    expect(config.gravityFall).toBeGreaterThan(config.gravityRise * 1.4);
  });

  it("letting go early cuts the jump: a tap is a hop, holding goes higher", () => {
    const peak = (hold: number) => {
      const w = flat();
      return startY - Math.min(...path(w, Array.from({ length: 40 }, (_, t) => (t < hold ? jump : idle))));
    };
    expect(peak(1)).toBeLessThan(35);
    expect(peak(3)).toBeGreaterThan(peak(1));
    expect(peak(40)).toBeGreaterThan(peak(3) + 20);
  });

  it("holding jump does not bunny-hop: the next jump needs a fresh press", () => {
    const w = flat();
    const ys = path(w, Array(60).fill(jump));
    const landed = ys.findIndex((y, i) => i > 3 && y === startY);
    expect(ys.slice(landed)).toEqual(Array(ys.length - landed).fill(startY));
  });

  it("cannot jump again in mid-air", () => {
    const w = flat();
    path(w, [jump, idle, idle]);
    const vy = pl(w).vy;
    path(w, [jump]);
    expect(pl(w).vy).toBeGreaterThan(vy);
  });

  it("coyote time: a jump just after running off a ledge still works, later it does not", () => {
    const run = { dx: 1, dy: 0, action: false };
    const tryJumpAfter = (ticksOff: number) => {
      const w = flat();
      const ledge = rulesPlatform(w, 200, startY - 100, 90);
      const p = pl(w);
      p.x = ledge.x + 45 - 1;
      p.y = platformTop(ledge) - config.playerR;
      p.vx = config.runSpeed;
      p.ground = true;
      p.data.on = ledge.id;
      let off = -1;
      for (let t = 0; t < 30 && off < 0; t++) { runTick(w, rules, { a: run }); if (!p.ground) off = t; }
      for (let t = 1; t < ticksOff; t++) runTick(w, rules, { a: run });
      const before = p.vy;
      runTick(w, rules, { a: { dx: 1, dy: 0, action: true } });
      return p.vy < before;
    };
    expect(tryJumpAfter(1)).toBe(true);
    expect(tryJumpAfter(config.coyoteTicks)).toBe(true);
    expect(tryJumpAfter(config.coyoteTicks + 2)).toBe(false);
  });

  it("jump buffer: pressing just before landing jumps on touchdown", () => {
    const landsAndJumps = (early: number) => {
      const w = flat();
      const p = pl(w);
      p.y = startY - 120;
      p.ground = false;
      let t = 0;
      // fall until `early` ticks before touchdown (found by a dry run)
      const dry = flat();
      pl(dry).y = startY - 120;
      pl(dry).ground = false;
      let touch = 0;
      while (!pl(dry).ground) { runTick(dry, rules, { a: idle }); touch++; }
      for (; t < touch - early; t++) runTick(w, rules, { a: idle });
      runTick(w, rules, { a: jump });
      for (let k = 0; k < early + 1; k++) runTick(w, rules, { a: jump });
      return p.y < startY - 10;
    };
    expect(landsAndJumps(1)).toBe(true);
    expect(landsAndJumps(config.jumpBufferTicks)).toBe(true);
    expect(landsAndJumps(config.jumpBufferTicks + 3)).toBe(false);
  });

  it("pressing up (dy < -0.5) jumps like the action button", () => {
    const w = flat();
    runTick(w, rules, { a: { dx: 0, dy: -1, action: false } });
    expect(pl(w).y).toBeLessThan(startY);
  });

  it("speeds up to runSpeed within a few ticks and stays inside the tower", () => {
    const w = flat();
    const p = pl(w);
    p.x = 100;
    path(w, Array(3).fill({ dx: 1, dy: 0, action: false }));
    expect(p.vx).toBe(config.runSpeed);
    path(w, Array(3).fill(idle));
    expect(p.vx).toBe(0);
    p.x = 3;
    path(w, Array(3).fill({ dx: -1, dy: 0, action: false }));
    expect(p.x).toBe(config.playerR);
  });

  it("moving platforms carry riders", () => {
    const w = flat();
    const mp = rulesPlatform(w, 300, startY - 100, 90, "moving");
    mp.data.range = 50;
    mp.data.dir = 1;
    const p = pl(w);
    p.x = mp.x;
    p.y = platformTop(mp) - config.playerR;
    p.data.on = mp.id;
    p.ground = true;
    runTick(w, rules, { a: idle });
    runTick(w, rules, { a: idle });
    expect(p.x).toBeCloseTo(300 + 2 * config.movingPlatformSpeed, 5);
    expect(p.ground).toBe(true);
  });

  it("bumping players push each other apart", () => {
    const w = flat();
    joinPlayer(w, rules, "b", "bob");
    const a = pl(w);
    const b = pl(w, "b");
    a.x = 300; b.x = 306;
    runTick(w, rules, { a: idle, b: idle });
    expect(b.x - a.x).toBeGreaterThanOrEqual(2 * config.playerR - 0.001);
    const ax = a.x;
    runTick(w, rules, { a: idle, b: idle });
    expect(a.x).toBeLessThan(ax);
  });
});

/** Adds a platform to a test world. */
function rulesPlatform(w: World, x: number, surface: number, width: number, type: PlatformData["type"] = "ledge"): Entity<PlatformData> {
  const h = config.platformH;
  const id = `test-${x}-${surface}`;
  w.entities[id] = { id, kind: "platform", x, y: surface + h / 2, vx: 0, vy: 0, r: width / 2, data: { w: width, h, type, ox: x, dx: 0 } };
  return w.entities[id] as unknown as Entity<PlatformData>;
}

describe("tower climb: the tower", () => {
  it("builds the ground, sectionCount sections and a top platform, deterministically", () => {
    const w = world(11);
    const ps = platforms(w);
    expect(new Set(ps.filter((q) => q.data.section !== undefined).map((q) => q.data.section)).size).toBe(config.sectionCount);
    expect(ps.filter((q) => q.data.type === "ground")).toHaveLength(1);
    const tops = ps.filter((q) => q.data.type === "top");
    expect(tops).toHaveLength(1);
    expect(platformTop(tops[0])).toBe(rd(w).topY);
    expect(JSON.stringify(world(11).entities)).toBe(JSON.stringify(w.entities));
    expect(bodies(w, "pellet")).toHaveLength(0);
  });

  it("gets harder going up: the first sections are plain ledges, lava only near the top", () => {
    expect(typesFor(0).map((t) => t.name)).toEqual(["ledges"]);
    expect(typesFor(config.sectionCount - 1).map((t) => t.name)).toContain("lava");
    expect(SECTION_TYPES.length).toBeGreaterThanOrEqual(5);
  });

  it("every next safe platform is within jump reach, and the tower fits the world", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const w = createWorld(seed);
      const topY = buildTower(w);
      expect(topY).toBeGreaterThan(0);
      let prev: Entity<PlatformData> | null = null;
      for (const q of platforms(w)) {
        const half = q.data.w / 2 + (q.data.range ?? 0);
        expect(q.data.ox - half).toBeGreaterThanOrEqual(-0.001);
        expect(q.data.ox + half).toBeLessThanOrEqual(config.towerWidth + 0.001);
        if (q.data.type === "kill") continue;
        if (prev && prev.data.type !== "ground") {
          const rise = platformTop(prev) - platformTop(q);
          expect(rise).toBeGreaterThan(30);
          expect(rise).toBeLessThan(MAX_RISE * 0.92);
          const gap = Math.abs(q.data.ox - prev.data.ox) - (q.data.w + prev.data.w) / 2;
          expect(gap).toBeLessThanOrEqual(maxGap(rise) * config.reachSafety + 0.001);
        }
        prev = q;
      }
    }
  });

  it("air time shrinks for higher steps and is 0 above the apex", () => {
    expect(airTicks(20)).toBeGreaterThan(airTicks(70));
    expect(airTicks(MAX_RISE + 1)).toBe(0);
  });
});

describe("tower climb: falls and kill bricks", () => {
  it("a missed jump drops you to whatever is below", () => {
    const w = flat();
    const high = rulesPlatform(w, 300, startY - 400, 90);
    const p = pl(w);
    p.x = high.x + 40;
    p.y = platformTop(high) - config.playerR;
    p.ground = true;
    p.data.on = high.id;
    path(w, Array(40).fill({ dx: 1, dy: 0, action: false }));
    expect(p.y).toBe(startY);
  });

  it("touching a kill brick sends you back to the ground and counts a death; your best height stays", () => {
    const w = flat();
    const lava = rulesPlatform(w, 300, startY - 300, 70, "kill");
    lava.data.h = config.killH;
    const p = pl(w);
    p.x = 300;
    p.y = platformTop(lava) - config.playerR - 2;
    p.data.best = p.y - 50;
    const best = p.data.best;
    runTick(w, rules, { a: idle });
    expect(p.y).toBe(startY);
    expect(p.data.deaths).toBe(1);
    expect(p.data.best).toBe(best);
    // you never stand on lava
    expect(p.ground).toBe(true);
  });

  it("lava sections put a kill brick right behind a ledge", () => {
    const lava = SECTION_TYPES.find((t) => t.name === "lava")!;
    const w = createWorld(5);
    const specs = lava.build(w, { x: 300, y: config.floorY, w: 300 });
    expect(specs.some((s) => s.type === "kill")).toBe(true);
  });
});

describe("tower climb: rounds", () => {
  it("touching the top ends the round and the toucher wins", () => {
    const w = world();
    const p = pl(w);
    const top = platforms(w).find((q) => q.data.type === "top")!;
    p.x = top.x;
    p.y = platformTop(top) - config.playerR - 5;
    p.ground = false;
    path(w, [], 5);
    expect(rd(w).phase).toBe("results");
    expect(rd(w).winner).toBe("a");
    expect(p.data.wins).toBe(1);
  });

  it("times out with the highest player winning", () => {
    const w = world();
    joinPlayer(w, rules, "b", "bob");
    pl(w).data.best = startY - 100;
    pl(w, "b").data.best = startY - 400;
    rd(w).ticksLeft = 1;
    runTick(w, rules, { a: idle, b: idle });
    expect(rd(w).phase).toBe("results");
    expect(rd(w).winner).toBe("b");
    expect(pl(w, "b").data.wins).toBe(1);
  });

  it("timeout with nobody progressed has no winner", () => {
    const w = world();
    rd(w).ticksLeft = 1;
    runTick(w, rules, { a: idle });
    expect(rd(w).winner).toBe("");
  });

  it("results freeze players, then a new tower and a reset", () => {
    const w = world();
    const oldIds = platforms(w).map((q) => q.id).join();
    const p = pl(w);
    p.x = 50; p.y = 1000; p.data.best = 1000; p.data.deaths = 3;
    const r = get<RoundData>(w, "round")!;
    r.data.phase = "results";
    r.data.ticksLeft = 3;
    runTick(w, rules, { a: { dx: 1, dy: 0, action: true } });
    expect(p.x).toBe(50);
    runTick(w, rules, { a: idle });
    runTick(w, rules, { a: idle });
    expect(rd(w).phase).toBe("play");
    expect(rd(w).round).toBe(2);
    expect(platforms(w).map((q) => q.id).join()).not.toBe(oldIds);
    expect(p.y).toBe(startY);
    expect(p.data.best).toBe(startY);
    expect(p.data.deaths).toBe(0);
  });

  it("a late joiner spawns at the bottom, also during results", () => {
    const w = world();
    rd(w).phase = "results";
    joinPlayer(w, rules, "c", "carol");
    expect(pl(w, "c").y).toBe(startY);
  });

  it("is deterministic for the same seed and inputs", () => {
    const run = () => {
      const w = world(42);
      joinPlayer(w, rules, "b", "bob");
      for (let t = 0; t < 400; t++) {
        runTick(w, rules, {
          a: { dx: t % 50 < 25 ? 1 : -1, dy: 0, action: t % 17 < 8 },
          b: { dx: t % 40 < 20 ? -1 : 1, dy: 0, action: t % 11 < 5 },
        });
      }
      return JSON.stringify(w);
    };
    expect(run()).toBe(run());
  });
});

describe("tower climb: bots", () => {
  it("bots climb: within a minute they get several sections up, and sometimes fall", () => {
    const w = createWorld(3);
    rules.init!(w);
    const ids = ["bot:1", "bot:2", "bot:3", "bot:4"];
    for (const id of ids) joinPlayer(w, rules, id, id);
    const heights: number[] = [];
    for (let t = 0; t < 60 * config.tickHz; t++) {
      const inputs: Record<string, Input> = {};
      ids.forEach((id, i) => { inputs[id] = rules.bot!(w, id, i + 1); });
      runTick(w, rules, inputs);
      if (rd(w).phase !== "play") break;
    }
    for (const id of ids) heights.push(startY - pl(w, id).data.best);
    const sectionPx = (config.floorY - rd(w).topY) / config.sectionCount;
    expect(Math.max(...heights)).toBeGreaterThan(3 * sectionPx);
    expect(Math.min(...heights)).toBeGreaterThan(sectionPx / 2);
  });

  it("bot inputs are valid wire inputs", () => {
    const w = world();
    const inp = rules.bot!(w, "a", 1);
    expect(Math.abs(inp.dx)).toBeLessThanOrEqual(1);
    expect(typeof inp.action).toBe("boolean");
  });
});
