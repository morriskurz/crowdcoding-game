import { describe, it, expect } from "vitest";
import { TickGuard, p95, KEY_PREFIX, type MinuteStats, type StatsStorage } from "./tick.js";

function memStorage() {
  const m = new Map<string, MinuteStats>();
  const s: StatsStorage = {
    async put(k, v) { m.set(k, structuredClone(v)); },
    async delete(k) { return m.delete(k); },
    async list({ prefix }) { return new Map([...m].filter(([k]) => k.startsWith(prefix))); },
  };
  return { m, s };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("TickGuard", () => {
  it("catches exceptions, keeps ticking and counts them", async () => {
    let t = 0;
    const { s } = memStorage();
    const g = new TickGuard(s, 66, 50, () => t, () => {});
    expect(g.run(() => { throw new Error("boom"); })).toBe(false);
    t += 66;
    let ran = false;
    expect(g.run(() => { ran = true; })).toBe(true);
    expect(ran).toBe(true);
    const { current } = await g.stats();
    expect(current).toMatchObject({ ticks: 2, exceptions: 1, overruns: 0 });
  });

  it("persists exceptions to storage and keeps per-minute buckets", async () => {
    let t = 0;
    const { m, s } = memStorage();
    const g = new TickGuard(s, 66, 50, () => t, () => {});
    g.run(() => { throw new Error("a"); });
    await flush();
    expect([...m.values()][0]).toMatchObject({ minute: 0, exceptions: 1 });

    t = 60_000; // next minute: previous bucket is flushed, current starts fresh
    g.run(() => { throw new Error("b"); });
    t += 66;
    g.run(() => {});
    await flush();
    const { current, recent } = await g.stats();
    expect(current).toMatchObject({ minute: 1, ticks: 2, exceptions: 1 });
    expect(recent.map((r) => [r.minute, r.exceptions])).toEqual([[0, 1]]);
    expect([...m.keys()].every((k) => k.startsWith(KEY_PREFIX))).toBe(true);
  });

  it("counts budget overruns from in-tick time and from late tick starts", async () => {
    let t = 0;
    const { s } = memStorage();
    const g = new TickGuard(s, 66, 50, () => t, () => {});
    g.run(() => { t += 80; }); // slow tick measured directly (Node, tests)
    t = 66 + 70;               // next tick fires 70ms late (how a slow tick shows up on Workers)
    g.run(() => {});
    t += 66;
    g.run(() => {});
    const { current } = await g.stats();
    expect(current.overruns).toBe(2);
    expect(current.maxMs).toBe(80);
  });

  it("survives a throwing error logger", () => {
    const { s } = memStorage();
    const g = new TickGuard(s, 66, 50, () => 0, () => { throw new Error("log down"); });
    expect(g.run(() => { throw new Error("tick"); })).toBe(false);
  });

  it("p95", () => {
    expect(p95([])).toBe(0);
    expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  });
});
