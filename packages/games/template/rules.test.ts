import { describe, it, expect } from "vitest";
import { createWorld, joinPlayer, runTick, bodies, get, type Entity, type World } from "@tcg/shared";
import { rules, SECTION_TYPES, COIN_GROW, PLAYER_MAX_R, buildTower, platformTop, type PlatformData, type PlayerData, type RoundData } from "./rules.js";
import { config } from "./config.js";

const idle = { dx: 0, dy: 0, action: false };
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

describe("template tower climb", () => {
  it("stands on the ground under gravity", () => {
    const w = world();
    const p = pl(w);
    for (const c of bodies(w, "pellet")) delete w.entities[c.id]; // falling through a coin would grow the player
    p.y = startY - 60;
    for (let t = 0; t < 60; t++) runTick(w, rules, { a: idle });
    expect(p.y).toBe(startY);
    expect(p.ground).toBe(true);
  });

  it("jumps, and holding the button jumps higher", () => {
    const peak = (hold: boolean) => {
      const w = world();
      let min = Infinity;
      for (let t = 0; t < 40; t++) {
        runTick(w, rules, { a: { dx: 0, dy: 0, action: t === 0 || hold } });
        min = Math.min(min, pl(w).y);
      }
      return min;
    };
    const tap = peak(false);
    const held = peak(true);
    expect(tap).toBeLessThan(startY - 40);
    expect(held).toBeLessThan(tap);
  });

  it("pressing up (dy < -0.5) jumps like the action button", () => {
    const up = world();
    runTick(up, rules, { a: { dx: 0, dy: -1, action: false } });
    expect(pl(up).y).toBeLessThan(startY);
    const none = world();
    runTick(none, rules, { a: { dx: 0, dy: 0, action: false } });
    expect(pl(none).y).toBe(startY);
  });

  it("cannot jump in mid-air", () => {
    const w = world();
    runTick(w, rules, { a: { dx: 0, dy: 0, action: true } });
    runTick(w, rules, { a: idle });
    const vy = pl(w).vy;
    runTick(w, rules, { a: { dx: 0, dy: 0, action: true } });
    expect(pl(w).vy).toBeGreaterThan(vy);
  });

  it("runs at runSpeed and stays inside the tower", () => {
    const w = world();
    const p = pl(w);
    p.x = 100;
    runTick(w, rules, { a: { dx: 1, dy: 0, action: false } });
    expect(p.x).toBe(100 + config.runSpeed);
    p.x = 3;
    runTick(w, rules, { a: { dx: -1, dy: 0, action: false } });
    expect(p.x).toBe(config.playerR);
  });

  it("falls off the edge of a ledge", () => {
    const w = world();
    const led = platforms(w).find((q) => q.data.type !== "ground" && q.data.type !== "moving")!;
    const p = pl(w);
    p.x = led.x;
    p.y = platformTop(led) - config.playerR;
    p.data.on = led.id;
    p.ground = true;
    for (let t = 0; t < 4; t++) runTick(w, rules, { a: idle });
    expect(p.y).toBe(platformTop(led) - config.playerR);
    for (let t = 0; t < 120; t++) runTick(w, rules, { a: { dx: 1, dy: 0, action: false } });
    expect(p.y).toBeGreaterThan(platformTop(led));
  });

  it("moving platforms carry riders", () => {
    const w = world();
    const mp = platforms(w).find((q) => q.data.type === "moving");
    if (!mp) return;
    const p = pl(w);
    mp.data.dir = 1;
    mp.x = mp.data.ox;
    p.x = mp.x;
    p.y = platformTop(mp) - config.playerR;
    p.data.on = mp.id;
    p.ground = true;
    const x0 = p.x;
    runTick(w, rules, { a: idle });
    expect(mp.x).toBeCloseTo(mp.data.ox + config.movingPlatformSpeed, 5);
    expect(p.x).toBeCloseTo(x0 + config.movingPlatformSpeed, 5);
  });

  it("bumping players push each other apart", () => {
    const w = world();
    joinPlayer(w, rules, "b", "bob");
    const a = pl(w);
    const b = pl(w, "b");
    a.x = 300; b.x = 306;
    runTick(w, rules, { a: idle, b: idle });
    expect(b.x - a.x).toBeGreaterThanOrEqual(2 * config.playerR - 0.001);
    expect(a.data.kick).toBe(-config.bumpPush);
    expect(b.data.kick).toBe(config.bumpPush);
    const ax = a.x;
    const bx = b.x;
    runTick(w, rules, { a: idle, b: idle });
    expect(a.x).toBeLessThan(ax);
    expect(b.x).toBeGreaterThan(bx);
  });

  it("builds sectionCount sections and a top platform, deterministically", () => {
    const w = world(11);
    const ps = platforms(w);
    expect(new Set(ps.filter((q) => q.data.section !== undefined).map((q) => q.data.section)).size).toBe(config.sectionCount);
    expect(ps.filter((q) => q.data.type === "ground")).toHaveLength(1);
    const tops = ps.filter((q) => q.data.type === "top");
    expect(tops).toHaveLength(1);
    expect(platformTop(tops[0])).toBe(rd(w).topY);
    expect(rd(w).topY).toBeLessThan(200);
    const again = world(11);
    expect(JSON.stringify(again.entities)).toBe(JSON.stringify(w.entities));
  });

  it("every section type stays within the tower and is reachable by jumping", () => {
    expect(SECTION_TYPES.length).toBeGreaterThanOrEqual(4);
    for (const type of SECTION_TYPES) {
      for (let seed = 1; seed <= 30; seed++) {
        const w = createWorld(seed);
        const specs = type.build(w, config.floorY);
        let prevTop: number = config.floorY;
        let prevExt: [number, number] = [0, config.towerWidth];
        for (const s of specs) {
          const range = s.type === "moving" ? (s.range ?? 100) : 0;
          const ext: [number, number] = [s.x - range - s.w / 2, s.x + range + s.w / 2];
          expect(ext[0]).toBeGreaterThanOrEqual(0);
          expect(ext[1]).toBeLessThanOrEqual(config.towerWidth);
          const rise = prevTop - s.y;
          expect(rise).toBeGreaterThan(0);
          expect(rise).toBeLessThan(75); // below the plain jump apex (~81)
          const gap = Math.max(ext[0] - prevExt[1], prevExt[0] - ext[1]);
          expect(gap).toBeLessThanOrEqual(85);
          prevTop = s.y;
          prevExt = ext;
        }
        expect(prevTop).toBe(config.floorY - config.sectionHeight);
      }
    }
  });

  it("buildTower puts all platforms inside the width", () => {
    const w = createWorld(3);
    buildTower(w);
    for (const p of platforms(w)) {
      expect(p.x - p.r).toBeGreaterThanOrEqual(-config.platformH);
      expect(p.x + p.r).toBeLessThanOrEqual(config.towerWidth + config.platformH);
    }
  });

  it("touching the top ends the round and the toucher wins", () => {
    const w = world();
    const p = pl(w);
    const top = platforms(w).find((q) => q.data.type === "top")!;
    p.x = top.x;
    p.y = platformTop(top) - config.playerR - 5;
    for (let t = 0; t < 5; t++) runTick(w, rules, { a: idle });
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
    expect(pl(w).data.wins).toBe(0);
  });

  it("timeout with nobody progressed has no winner", () => {
    const w = world();
    rd(w).ticksLeft = 1;
    runTick(w, rules, { a: idle });
    expect(rd(w).phase).toBe("results");
    expect(rd(w).winner).toBe("");
  });

  it("results freeze players, then a new tower and a reset", () => {
    const w = world();
    const oldIds = platforms(w).map((q) => q.id).join();
    const p = pl(w);
    p.x = 50; p.y = 1000; p.data.best = 1000;
    const r = get<RoundData>(w, "round")!;
    r.data.phase = "results";
    r.data.ticksLeft = 3;
    runTick(w, rules, { a: { dx: 1, dy: 0, action: true } });
    expect(p.x).toBe(50);
    expect(p.y).toBe(1000);
    runTick(w, rules, { a: idle });
    runTick(w, rules, { a: idle });
    expect(rd(w).phase).toBe("play");
    expect(rd(w).round).toBe(2);
    expect(rd(w).winner).toBe("");
    expect(platforms(w).map((q) => q.id).join()).not.toBe(oldIds);
    expect(platforms(w).filter((q) => q.data.type === "top")).toHaveLength(1);
    expect(p.y).toBe(startY);
    expect(p.data.best).toBe(startY);
  });

  it("a late joiner spawns at the bottom, also during results", () => {
    const w = world();
    rd(w).phase = "results";
    joinPlayer(w, rules, "c", "carol");
    const c = pl(w, "c") as Entity<PlayerData>;
    expect(c.y).toBe(startY);
    expect(c.x).toBeGreaterThanOrEqual(config.playerR);
    expect(c.x).toBeLessThanOrEqual(config.towerWidth - config.playerR);
  });

  it("leaving despawns the player", () => {
    const w = world();
    rules.leave ? rules.leave(w, "a") : delete w.entities["a"];
    expect(get(w, "a")).toBeUndefined();
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

  it("the tower holds coins (pellets), near the ground and on ledges", () => {
    const w = world();
    const coins = bodies(w, "pellet");
    expect(coins.length).toBeGreaterThan(config.sectionCount);
    expect(coins.some((c) => c.y > config.floorY - 30)).toBe(true);
    expect(coins.some((c) => c.y < config.floorY - config.sectionHeight)).toBe(true);
  });

  it("touching a coin collects it and grows the player up to a cap", () => {
    const w = world();
    const p = pl(w);
    const coin = bodies(w, "pellet")[0];
    p.x = coin.x;
    p.y = coin.y;
    const n = bodies(w, "pellet").length;
    runTick(w, rules, { a: idle });
    expect(get(w, coin.id)).toBeUndefined();
    expect(bodies(w, "pellet").length).toBeLessThan(n);
    expect(p.r).toBeCloseTo(config.playerR + COIN_GROW, 5);
    p.r = PLAYER_MAX_R;
    const c2 = bodies(w, "pellet")[0];
    p.x = c2.x;
    p.y = c2.y;
    runTick(w, rules, { a: idle });
    expect(p.r).toBe(PLAYER_MAX_R);
  });

  it("a grown player still lands on the ground and a new round resets size and coins", () => {
    const w = world();
    const p = pl(w);
    p.r = PLAYER_MAX_R;
    p.y = config.floorY - 20;
    p.x = 300;
    for (let t = 0; t < 60; t++) runTick(w, rules, { a: idle });
    expect(p.y).toBe(config.floorY - PLAYER_MAX_R);
    rd(w).phase = "results";
    rd(w).ticksLeft = 1;
    runTick(w, rules, { a: idle });
    expect(p.r).toBe(config.playerR);
    expect(bodies(w, "pellet").length).toBeGreaterThan(config.sectionCount);
  });
});
