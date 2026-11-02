import { describe, expect, it, vi } from "vitest";
import type { Entity } from "@tcg/shared";
import { drawOverlay, onSnapshot } from "./assets.js";
import { config } from "./config.js";

type Ents = Record<string, Entity>;

function ent(id: string, kind: string, data: Record<string, unknown>, x = 100, y = 100): Entity {
  return { id, kind, x, y, vx: 0, vy: 0, r: 14, data } as unknown as Entity;
}

function roundEnt(): Entity {
  return ent("round", "round", { phase: "play", round: 1, tiles: ".".repeat(config.cols * config.rows) });
}

function mockFx(time: number) {
  return {
    time,
    me: "",
    names: {},
    camera: { shake() {}, viewW: 800, viewH: 600, zoom: 1, worldToScreen: (x: number, y: number) => ({ x, y }) },
    particles: { emit: vi.fn() },
    sfx: { play: vi.fn() },
  } as any;
}

function mockCtx() {
  const fills: number[][] = [];
  const ctx: any = new Proxy({}, {
    get(_t, prop) {
      if (prop === "fillRect") return (...a: number[]) => { fills.push(a); };
      if (prop === "measureText") return () => ({ width: 50 });
      return () => undefined;
    },
    set() { return true; },
  });
  return { ctx, fills };
}

/** prev/next maps where `n` victims die to killer `k` whose chain is `chain`. */
function scenario(n: number, chain: number): { prev: Ents; next: Ents } {
  const prev: Ents = { round: roundEnt(), k: ent("k", "player", { deaths: 0, chain, bonus: 0, ko: 0 }, 300, 300) };
  const next: Ents = { round: roundEnt(), k: ent("k", "player", { deaths: 0, chain, bonus: 0, ko: n }, 300, 300) };
  for (let i = 0; i < n; i++) {
    const id = `v${i}`;
    prev[id] = ent(id, "player", { deaths: 0, killer: "", ko: 0 }, 100 + i * 10, 100);
    next[id] = ent(id, "player", { deaths: 1, killer: "k", ko: 0 }, 100 + i * 10, 100);
  }
  return { prev, next };
}

const chainEmits = (fx: any) =>
  fx.particles.emit.mock.calls.filter(([o]: any[]) => o.count === 12 && o.color === "#ffd54a" && o.life === 0.6 && o.size === 3);

const fullFlash = (fills: number[][]) => fills.some((a) => a[0] === 0 && a[1] === 0 && a[2] === 800 && a[3] === 600);

describe("chain KO effects", () => {
  it("emits a chain burst when the killer has chain >= 2", () => {
    const fx = mockFx(10);
    const { prev, next } = scenario(1, 2);
    onSnapshot(prev, next, fx);
    expect(chainEmits(fx)).toHaveLength(1);
  });

  it("emits no chain burst when the killer chain is 1", () => {
    const fx = mockFx(20);
    const { prev, next } = scenario(1, 1);
    onSnapshot(prev, next, fx);
    expect(chainEmits(fx)).toHaveLength(0);
  });

  it("flashes the whole screen briefly after 5 chained KOs in one snapshot", () => {
    const fx = mockFx(100);
    const { prev, next } = scenario(5, 3);
    onSnapshot(prev, next, fx);
    const early = mockCtx();
    drawOverlay(early.ctx, mockFx(100.1));
    expect(fullFlash(early.fills)).toBe(true);
    const late = mockCtx();
    drawOverlay(late.ctx, mockFx(100.4));
    expect(fullFlash(late.fills)).toBe(false);
  });

  it("does not flash with only 4 chained KOs", () => {
    const fx = mockFx(200);
    const { prev, next } = scenario(4, 3);
    onSnapshot(prev, next, fx);
    const c = mockCtx();
    drawOverlay(c.ctx, mockFx(200.1));
    expect(fullFlash(c.fills)).toBe(false);
  });
});
