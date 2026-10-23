import { describe, it, expect } from "vitest";
import type { Entity } from "@tcg/shared";
import { Director } from "./director.js";

const ent = (id: string, kind: string, x: number, y: number, r = 10): Entity => ({ id, kind, x, y, vx: 0, vy: 0, r, data: {} });
const byId = (...es: Entity[]) => Object.fromEntries(es.map((e) => [e.id, e]));
const DT = 1 / 15;

describe("Director (spectator camera)", () => {
  it("follows the player where things happen, not the idle one", () => {
    const d = new Director();
    const names = { idle: "anon", busy: "alice" };
    let pellets = Array.from({ length: 100 }, (_, i) => ent(`p${i}`, "pellet", 800 + i * 5, 800));
    for (let t = 0; t < 90; t++) { // 6 s: past minDwell on the first (biggest) pick
      // busy moves along the pellet row and eats one per snapshot; idle stands still far away
      const busy = ent("busy", "player", 790 + t * 5, 800, 10 + t);
      pellets = pellets.filter((p) => Math.abs(p.x - busy.x) > 3);
      d.observe(byId(ent("idle", "player", 100, 100, 30), busy, ...pellets), names, DT);
    }
    expect(d.focus).toBe("busy");
    expect(d.heat.get("busy")!).toBeGreaterThan(d.heat.get("idle")!);
  });

  it("with nothing happening, shows the biggest player", () => {
    const d = new Director();
    d.observe(byId(ent("a", "player", 0, 0, 5), ent("b", "player", 500, 500, 40)), { a: "a", b: "b" }, DT);
    expect(d.focus).toBe("b");
  });

  it("does not flicker: stays on the focus for minDwell, switches to a clearly hotter player after", () => {
    const d = new Director({ minDwell: 3 });
    const names = { a: "a", b: "b" };
    d.observe(byId(ent("a", "player", 0, 0, 20), ent("b", "player", 1000, 1000)), names, DT);
    expect(d.focus).toBe("a");
    // b starts growing fast right away
    let t = 0;
    for (; t < 15; t++) d.observe(byId(ent("a", "player", 0, 0, 20), ent("b", "player", 1000, 1000, 10 + t * 2)), names, DT);
    expect(d.focus).toBe("a"); // 1 s in: still dwelling
    for (; t < 60; t++) d.observe(byId(ent("a", "player", 0, 0, 20), ent("b", "player", 1000, 1000, 10 + t * 2)), names, DT);
    expect(d.focus).toBe("b");
  });

  it("drops a focus that left and frames nearby hot players together", () => {
    const d = new Director({ reach: 200 });
    d.observe(byId(ent("a", "player", 100, 100, 30), ent("b", "player", 150, 100, 10)), { a: "a", b: "b" }, DT);
    expect(d.focus).toBe("a");
    const list = [ent("a", "player", 100, 100, 30), ent("b", "player", 150, 100, 10)];
    const t = d.target(list);
    expect(t.x).toBeGreaterThanOrEqual(100);
    expect(t.x).toBeLessThan(150);
    d.observe(byId(ent("b", "player", 150, 100, 10)), { b: "b" }, DT);
    expect(d.focus).toBe("b");
    d.observe({}, {}, DT);
    expect(d.focus).toBeNull();
    expect(d.target([])).toEqual({ x: t.x, y: t.y }); // keeps the last view
  });
});
