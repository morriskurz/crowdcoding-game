import { describe, it, expect } from "vitest";
import { createWorld, joinPlayer, runTick, bodies, get, type Input, type World } from "@tcg/shared";
import {
  rules, buildTiles, centre, cellOf, idx, tileAt, freeCell, BLOCK_TYPES, BOMB_TYPES, PICKUP_TYPES, ROUND_ID,
  type BlastData, type BombData, type PickupData, type PlayerData, type RoundData,
} from "./rules.js";
import { config } from "./config.js";

const idle: Input = { dx: 0, dy: 0, action: false };
const bomb: Input = { dx: 0, dy: 0, action: true };
const right: Input = { dx: 1, dy: 0, action: false };

const rd = (w: World) => get<RoundData>(w, ROUND_ID)!.data;
const pl = (w: World, id: string) => get<PlayerData>(w, id)!;
const bombs = (w: World) => bodies<BombData>(w, "bomb");
const blasts = (w: World) => bodies<BlastData>(w, "blast");

/** Walls and pillars only: no bricks, so tests place what they need. */
function openTiles(): string {
  let s = "";
  for (let y = 0; y < config.rows; y++) {
    for (let x = 0; x < config.cols; x++) {
      const wall = x === 0 || y === 0 || x === config.cols - 1 || y === config.rows - 1 || (x % 2 === 0 && y % 2 === 0);
      s += wall ? "#" : ".";
    }
  }
  return s;
}

function setTile(w: World, cx: number, cy: number, ch: string): void {
  const r = rd(w);
  const i = idx(cx, cy);
  r.tiles = r.tiles.slice(0, i) + ch + r.tiles.slice(i + 1);
}

/** An open arena with the given players, unprotected, at the given cells. */
function arena(players: Record<string, [number, number]>, seed = 7): World {
  const w = createWorld(seed);
  rules.init!(w);
  rd(w).tiles = openTiles();
  for (const [id, [cx, cy]] of Object.entries(players)) {
    joinPlayer(w, rules, id, id);
    put(w, id, cx, cy);
  }
  return w;
}

function put(w: World, id: string, cx: number, cy: number): void {
  const p = pl(w, id);
  p.x = centre(cx);
  p.y = centre(cy);
  p.data.protect = 0;
}

function tick(w: World, inputs: Record<string, Input> = {}, n = 1): void {
  for (let i = 0; i < n; i++) {
    const all: Record<string, Input> = {};
    for (const p of bodies(w, "player")) all[p.id] = inputs[p.id] ?? idle;
    runTick(w, rules, all);
  }
}

describe("arena", () => {
  it("has border walls, pillars on even cells, free corners and seeded bricks", () => {
    const w = createWorld(3);
    rules.init!(w);
    const r = rd(w);
    expect(r.tiles.length).toBe(config.cols * config.rows);
    for (let x = 0; x < config.cols; x++) { expect(tileAt(r, x, 0)).toBe("#"); expect(tileAt(r, x, config.rows - 1)).toBe("#"); }
    expect(tileAt(r, 2, 2)).toBe("#");
    expect(tileAt(r, 4, 6)).toBe("#");
    for (const [x, y] of [[1, 1], [2, 1], [1, 2], [13, 11], [12, 11], [13, 10]]) expect(tileAt(r, x, y)).toBe(".");
    const bricks = [...r.tiles].filter((c) => c === BLOCK_TYPES[0].char).length;
    expect(bricks).toBeGreaterThan(20);
    expect(rules.arena).toEqual({ w: config.cols * config.cell, h: config.rows * config.cell });
  });

  it("is the same for the same seed and different for another", () => {
    const a = createWorld(11), b = createWorld(11), c = createWorld(12);
    expect(buildTiles(a)).toBe(buildTiles(b));
    expect(buildTiles(a)).not.toBe(buildTiles(c));
  });

  it("day one lists: brick blocks, a normal bomb, a blast+1 pickup", () => {
    expect(BLOCK_TYPES.map((b) => b.name)).toEqual(["brick"]);
    expect(BOMB_TYPES.map((b) => b.name)).toEqual(["normal"]);
    expect(PICKUP_TYPES.map((p) => p.name)).toEqual(["blast+1"]);
  });
});

describe("players", () => {
  it("spawn on a free floor cell inside the arena, protected, with a numeric size", () => {
    const w = createWorld(5);
    rules.init!(w);
    for (let i = 0; i < 30; i++) joinPlayer(w, rules, `p${i}`, `p${i}`);
    for (const p of bodies<PlayerData>(w, "player")) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(rules.arena!.w);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(rules.arena!.h);
      expect(typeof p.r).toBe("number");
      expect(tileAt(rd(w), cellOf(p.x), cellOf(p.y))).toBe(".");
      expect(p.data.protect).toBe(config.protectTicks);
    }
  });

  it("move with input and stop at walls and bricks", () => {
    const w = arena({ a: [1, 1] });
    tick(w, { a: right }, 4);
    expect(pl(w, "a").x).toBe(centre(1) + 4 * config.moveSpeed);
    tick(w, { a: { dx: -1, dy: 0, action: false } }, 20);
    expect(pl(w, "a").x).toBe(centre(1)); // wall at column 0
    setTile(w, 2, 1, "b");
    tick(w, { a: right }, 20);
    expect(pl(w, "a").x).toBe(centre(1)); // brick at (2,1)
  });

  it("line up with the row before turning a corner", () => {
    const w = arena({ a: [1, 1] });
    pl(w, "a").y = centre(1) + 6; // slightly into (1,2)'s direction but still in row 1
    tick(w, { a: right });
    expect(pl(w, "a").y).toBe(centre(1) + 1);
    tick(w, { a: right });
    expect(pl(w, "a").y).toBe(centre(1));
    expect(pl(w, "a").x).toBeGreaterThan(centre(1));
  });
});

describe("bombs", () => {
  it("one live bomb per player, one per fresh press", () => {
    const w = arena({ a: [1, 1] });
    tick(w, { a: bomb }, 5); // held: still one
    expect(bombs(w).length).toBe(1);
    tick(w, { a: right }, 8); // walk off it
    tick(w, { a: bomb });
    expect(bombs(w).length).toBe(1);
    expect(bombs(w)[0].data.cx).toBe(1);
  });

  it("go off exactly 3 s after they are dropped", () => {
    const w = arena({ a: [1, 1], z: [13, 11] });
    tick(w, { a: bomb });
    put(w, "a", 5, 5);
    tick(w, {}, config.fuseTicks - 1);
    expect(bombs(w).length).toBe(1);
    expect(blasts(w).length).toBe(0);
    tick(w);
    expect(bombs(w).length).toBe(0);
    expect(blasts(w).length).toBe(1);
    expect(config.fuseTicks).toBe(3 * config.tickHz);
  });

  it("blast cross stops at pillars and breaks only the first brick", () => {
    const w = arena({ a: [2, 1] });
    setTile(w, 3, 1, "b");
    setTile(w, 4, 1, "b");
    tick(w, { a: bomb });
    put(w, "a", 9, 9);
    bombs(w)[0].data.fuse = 1;
    tick(w);
    const r = rd(w);
    expect(tileAt(r, 3, 1)).toBe(".");
    expect(tileAt(r, 4, 1)).toBe("b");
    const b = blasts(w)[0].data;
    expect(b.right).toBe(1); // first brick
    expect(b.left).toBe(1); // border wall after (1,1)
    expect(b.up).toBe(0); // border wall
    expect(b.down).toBe(0); // pillar at (2,2)
  });

  it("players cannot walk onto someone's bomb but can leave their own", () => {
    const w = arena({ a: [1, 1], b: [3, 1] });
    tick(w, { b: bomb });
    tick(w, { a: right }, 20);
    expect(cellOf(pl(w, "a").x)).toBe(2);
    expect(pl(w, "a").x).toBe(centre(2));
    tick(w, { b: right }, 8);
    expect(cellOf(pl(w, "b").x)).toBe(4);
  });
});

describe("knockouts", () => {
  it("chain reaction: every knockout goes to the owner of the bomb that started it", () => {
    const w = arena({ a: [1, 1], b: [3, 1], c: [5, 1] });
    tick(w, { a: bomb, b: bomb });
    put(w, "a", 1, 5); // safe
    put(w, "b", 3, 3); // in b's own (chained) blast
    // c stays at (5,1): in reach of b's bomb only
    const [ba, bb] = bombs(w);
    ba.data.fuse = 1;
    bb.data.fuse = 40;
    tick(w);
    expect(bombs(w).length).toBe(0);
    expect(blasts(w).every((b) => b.data.owner === "a")).toBe(true);
    expect(pl(w, "c").data.dead).toBe(true);
    expect(pl(w, "b").data.dead).toBe(true);
    expect(pl(w, "a").data.dead).toBe(false);
    expect(pl(w, "a").data.ko).toBe(2);
    expect(pl(w, "b").data.ko).toBe(0);
    expect(pl(w, "c").data.killer).toBe("a");
  });

  it("a bomb dropped into a burning blast goes off at once, credited to the blast's owner", () => {
    const w = arena({ a: [1, 1], b: [3, 1], c: [3, 3] });
    tick(w, { a: bomb });
    put(w, "a", 1, 5);
    bombs(w)[0].data.fuse = 1;
    pl(w, "b").data.protect = 99; // b stands in the blast, protected, and drops a bomb there
    tick(w);
    tick(w, { b: bomb });
    tick(w);
    expect(pl(w, "c").data.dead).toBe(true);
    expect(pl(w, "a").data.ko).toBe(1);
  });

  it("records the chain size and a rising chainSeq on the player who started it", () => {
    const w = arena({ a: [1, 1] });
    expect(pl(w, "a").data.chain).toBe(0);
    expect(pl(w, "a").data.chainSeq).toBe(0);
    tick(w, { a: bomb });
    put(w, "a", 1, 5);
    bombs(w)[0].data.fuse = 1;
    tick(w);
    expect(pl(w, "a").data.chain).toBe(1);
    expect(pl(w, "a").data.chainSeq).toBe(1);

    const w2 = arena({ a: [1, 1], b: [3, 1], c: [5, 1] });
    tick(w2, { a: bomb, b: bomb, c: bomb });
    put(w2, "a", 1, 5);
    put(w2, "b", 7, 5);
    put(w2, "c", 9, 9);
    const ordered = bombs(w2).sort((p, q) => p.data.cx - q.data.cx);
    ordered[0].data.fuse = 1;
    ordered[1].data.fuse = 40;
    ordered[2].data.fuse = 40;
    tick(w2);
    expect(bombs(w2).length).toBe(0);
    expect(pl(w2, "a").data.chain).toBe(3);
    expect(pl(w2, "a").data.chainSeq).toBe(1);
    expect(pl(w2, "b").data.chainSeq).toBe(0);
    expect(pl(w2, "c").data.chainSeq).toBe(0);

    // a second chain by the same player
    tick(w2, {}, config.blastTicks + 1);
    pl(w2, "a").data.dead = false;
    put(w2, "a", 1, 1);
    tick(w2, { a: bomb });
    put(w2, "a", 1, 5);
    bombs(w2)[0].data.fuse = 1;
    tick(w2);
    expect(pl(w2, "a").data.chain).toBe(1);
    expect(pl(w2, "a").data.chainSeq).toBe(2);
  });

  describe("crown", () => {
    /** Players `ids` each drop a bomb in a row at y, left to right 2 cells apart from x=1; the first one fires. */
    function chainRow(w: World, ids: string[], y: number): void {
      ids.forEach((id, i) => put(w, id, 1 + 2 * i, y));
      tick(w, Object.fromEntries(ids.map((id) => [id, bomb])));
      ids.forEach((id, i) => put(w, id, 1 + 2 * i, 11)); // everyone out of the way
      const ordered = bombs(w).sort((p, q) => p.data.cx - q.data.cx);
      ordered[0].data.fuse = 1;
      for (let i = 1; i < ordered.length; i++) ordered[i].data.fuse = 40;
      tick(w);
      expect(bombs(w).length).toBe(0);
    }
    const settle = (w: World) => tick(w, {}, config.blastTicks + 1);
    // explodeBombs awards the crown, then the same step counts it down once.
    const fresh = config.crownTicks - 1;

    it("goes to a player finishing a chain of 1 or more", () => {
      const w1 = arena({ a: [1, 1] });
      chainRow(w1, ["a"], 1);
      expect(pl(w1, "a").data.chain).toBe(1);
      expect(pl(w1, "a").data.crown).toBe(fresh);
      const w = arena({ a: [1, 1], b: [3, 1] });
      chainRow(w, ["a", "b"], 1);
      expect(pl(w, "a").data.chain).toBe(2);
      expect(pl(w, "a").data.crown).toBe(fresh);
      expect(pl(w, "b").data.crown).toBe(0);
    });

    it("moves to a longer chain by another player and is not stolen by a shorter one", () => {
      const w = arena({ a: [1, 1], b: [3, 1], c: [1, 5], d: [3, 5], e: [5, 5] });
      chainRow(w, ["a", "b"], 1);
      expect(pl(w, "a").data.crown).toBe(fresh);
      settle(w);
      chainRow(w, ["c", "d", "e"], 5);
      expect(pl(w, "c").data.chain).toBe(3);
      expect(pl(w, "c").data.crown).toBe(fresh);
      expect(pl(w, "a").data.crown).toBe(0);
      settle(w);
      const held = pl(w, "c").data.crown;
      expect(held).toBeGreaterThan(0);
      chainRow(w, ["a", "b"], 1); // shorter chain by another player
      expect(pl(w, "a").data.chain).toBe(2);
      expect(pl(w, "a").data.crown).toBe(0);
      expect(pl(w, "c").data.crown).toBe(held - 2); // the two ticks of chainRow
    });

    it("counts down by 1 per step and runs out after crownTicks steps", () => {
      const w = arena({ a: [1, 1], b: [3, 1], z: [13, 11] });
      chainRow(w, ["a", "b"], 1);
      expect(pl(w, "a").data.crown).toBe(fresh);
      tick(w);
      expect(pl(w, "a").data.crown).toBe(fresh - 1);
      tick(w, {}, fresh - 2);
      expect(pl(w, "a").data.crown).toBe(1);
      tick(w);
      expect(pl(w, "a").data.crown).toBe(0);
      tick(w);
      expect(pl(w, "a").data.crown).toBe(0);
    });
  });

  it("self knockouts score nothing", () => {
    const w = arena({ a: [1, 1] });
    tick(w, { a: bomb });
    bombs(w)[0].data.fuse = 1;
    tick(w);
    expect(pl(w, "a").data.dead).toBe(true);
    expect(pl(w, "a").data.deaths).toBe(1);
    expect(pl(w, "a").data.ko).toBe(0);
  });

  it("respawn after 3 s on a free cell with 2 s of protection", () => {
    const w = arena({ a: [1, 1], b: [7, 7] });
    tick(w, { a: bomb });
    bombs(w)[0].data.fuse = 1;
    tick(w);
    expect(pl(w, "a").data.dead).toBe(true);
    tick(w, {}, config.respawnTicks - 1);
    expect(pl(w, "a").data.dead).toBe(true);
    tick(w);
    const a = pl(w, "a");
    expect(a.data.dead).toBe(false);
    expect(a.data.protect).toBe(config.protectTicks);
    expect(tileAt(rd(w), cellOf(a.x), cellOf(a.y))).toBe(".");
    expect(config.respawnTicks).toBe(3 * config.tickHz);
    expect(config.protectTicks).toBe(2 * config.tickHz);
  });

  it("protected players survive blasts until protection runs out", () => {
    const w = arena({ a: [1, 1], b: [3, 1] });
    pl(w, "b").data.protect = config.protectTicks;
    tick(w, { a: bomb });
    put(w, "a", 1, 5);
    bombs(w)[0].data.fuse = 1;
    tick(w);
    expect(pl(w, "b").data.dead).toBe(false);
    const w2 = arena({ a: [1, 1], b: [3, 1] });
    tick(w2, { a: bomb });
    put(w2, "a", 1, 5);
    bombs(w2)[0].data.fuse = 1;
    tick(w2);
    expect(pl(w2, "b").data.dead).toBe(true);
  });

  it("free cells avoid bombs and their blast lines", () => {
    const w = arena({ a: [7, 5] });
    tick(w, { a: bomb });
    for (let i = 0; i < 50; i++) {
      const [cx, cy] = freeCell(w, rd(w));
      expect(cx === 7 && Math.abs(cy - 5) <= 2).toBe(false);
      expect(cy === 5 && Math.abs(cx - 7) <= 2).toBe(false);
    }
  });
});

describe("pickups", () => {
  it("blast+1 adds a cell of range, capped", () => {
    const w = arena({ a: [1, 1] });
    const k = { kind: "pickup", x: centre(2), y: centre(1), r: 10, data: { type: "blast+1", cx: 2, cy: 1 } satisfies PickupData };
    w.entities.k1 = { id: "k1", vx: 0, vy: 0, ...k };
    tick(w, { a: right }, 6);
    expect(pl(w, "a").data.range).toBe(config.blastRange + 1);
    expect(get(w, "k1")).toBeUndefined();
    const d = pl(w, "a").data;
    for (let i = 0; i < 20; i++) PICKUP_TYPES[0].apply(d);
    expect(d.range).toBe(config.maxBlastRange);
  });
});

describe("round loop", () => {
  it("180 s of play, 5 s of results, then a fresh arena with scores reset", () => {
    const w = arena({ a: [1, 1] });
    pl(w, "a").data.ko = 4;
    const before = rd(w).tiles;
    expect(rd(w).ticksLeft).toBe(180 * config.tickHz);
    tick(w, {}, 180 * config.tickHz - 1);
    expect(rd(w).phase).toBe("play");
    tick(w);
    expect(rd(w).phase).toBe("results");
    expect(rd(w).winner).toBe("a");
    tick(w, {}, 5 * config.tickHz - 1);
    expect(rd(w).phase).toBe("results");
    tick(w);
    expect(rd(w).phase).toBe("play");
    expect(rd(w).round).toBe(2);
    expect(pl(w, "a").data.ko).toBe(0);
    expect(rd(w).tiles).not.toBe(before);
    expect(rd(w).ticksLeft).toBe(180 * config.tickHz);
  });
});

describe("bots and determinism", () => {
  function botRun(seed: number, ticks: number): World {
    const w = createWorld(seed);
    rules.init!(w);
    for (let i = 1; i <= 8; i++) joinPlayer(w, rules, `bot:${i}`, `bot${i}`);
    for (let t = 0; t < ticks; t++) {
      const inputs: Record<string, Input> = {};
      for (let i = 1; i <= 8; i++) inputs[`bot:${i}`] = rules.bot!(w, `bot:${i}`, i);
      runTick(w, rules, inputs);
    }
    return w;
  }

  it("same seed and inputs give the same world", () => {
    expect(JSON.stringify(botRun(9, 600))).toBe(JSON.stringify(botRun(9, 600)));
  });

  it("every bot gets moving within 3 s of joining, whatever the seed", () => {
    for (let seed = 1; seed <= 100; seed++) {
      const w = createWorld(seed * 7919);
      rules.init!(w);
      joinPlayer(w, rules, "human", "human");
      const ids = [1, 2, 3, 4, 5].map((i) => `bot:${i}`);
      for (const id of ids) joinPlayer(w, rules, id, id);
      const start = ids.map((id) => [pl(w, id).x, pl(w, id).y]);
      for (let t = 0; t < 3 * config.tickHz; t++) {
        const inputs: Record<string, Input> = { human: idle };
        ids.forEach((id, i) => { inputs[id] = rules.bot!(w, id, i + 1); });
        runTick(w, rules, inputs);
      }
      const still = ids.filter((id, i) => pl(w, id).x === start[i][0] && pl(w, id).y === start[i][1]);
      expect({ seed, still }).toEqual({ seed, still: [] });
    }
  });

  it("bots bomb bricks and stay inside the arena", () => {
    const w0 = createWorld(9);
    rules.init!(w0);
    const start = [...rd(w0).tiles].filter((c) => c === "b").length;
    const w = botRun(9, 900);
    const now = [...rd(w).tiles].filter((c) => c === "b").length;
    expect(now).toBeLessThan(start - 5);
    for (const p of bodies(w, "player")) {
      expect(p.x).toBeGreaterThan(0);
      expect(p.x).toBeLessThan(rules.arena!.w);
      expect(p.y).toBeGreaterThan(0);
      expect(p.y).toBeLessThan(rules.arena!.h);
    }
  });
});
