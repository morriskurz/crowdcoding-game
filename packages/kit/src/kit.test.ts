import { describe, it, expect } from "vitest";
import { Camera, FixedStep, Particles, SnapshotBuffer, Sfx, SOUND_NAMES, Trail, Tween, damp, ease, lerpBodies, tween } from "./index.js";

const TICK = 1000 / 15;
type B = { id: string; x: number; y: number; r: number };
const snap = (x: number, r = 8): Record<string, B> => ({ p: { id: "p", x, y: 0, r } });

describe("SnapshotBuffer", () => {
  it("renders `delay` ticks behind and blends between neighbours", () => {
    const buf = new SnapshotBuffer<Record<string, B>>({ hz: 15, delay: 2 });
    for (let t = 0; t <= 5; t++) buf.push(t, snap(t * 10), t * TICK);
    const s = buf.sample(5 * TICK)!; // newest tick 5 -> shows tick 3
    expect(s.tick).toBeCloseTo(3, 9);
    const half = buf.sample(5.5 * TICK)!; // shows 3.5
    expect(half.t).toBeCloseTo(0.5, 9);
    expect(lerpBodies(half.a, half.b, half.t)[0].x).toBeCloseTo(35, 9);
  });

  it("is smooth: rendered x advances monotonically at 60 fps despite jitter", () => {
    const buf = new SnapshotBuffer<Record<string, B>>({ hz: 15, delay: 2 });
    let seed = 3;
    const jitter = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 20; // 0..20 ms
    let last = -Infinity;
    let next = 0;
    for (let now = 0; now < 3000; now += 1000 / 60) {
      while (next * TICK + 30 <= now) { buf.push(next, snap(next * 10), next * TICK + 30 + jitter()); next++; }
      const s = buf.sample(now);
      if (!s) continue;
      const x = lerpBodies(s.a, s.b, s.t)[0].x;
      expect(x).toBeGreaterThanOrEqual(last - 1e-6);
      last = x;
    }
    expect(last).toBeGreaterThan(300);
  });

  it("holds the newest snapshot when starved and the oldest before the window", () => {
    const buf = new SnapshotBuffer<string>({ delay: 2 });
    expect(buf.sample(0)).toBeNull();
    buf.push(10, "a", 0);
    buf.push(11, "b", TICK);
    expect(buf.sample(0)!.a).toBe("a");
    const late = buf.sample(100 * TICK)!;
    expect([late.a, late.b, late.t]).toEqual(["b", "b", 0]);
  });

  it("drops duplicates/out-of-order, restarts when the room restarts, caps size", () => {
    const buf = new SnapshotBuffer<number>({ size: 4 });
    for (let t = 100; t < 110; t++) buf.push(t, t, t * TICK);
    expect(buf.length).toBe(4);
    buf.push(108, -1, 0);
    expect(buf.newest).toBe(109);
    buf.push(1, 1, 111 * TICK); // tick far behind: new room
    expect([buf.length, buf.newestTick]).toEqual([1, 1]);
  });

  it("lerpBodies: appear, vanish, snap on teleport, lerp radius", () => {
    const a = { p: { id: "p", x: 0, y: 0, r: 8 }, gone: { id: "gone", x: 0, y: 0, r: 1 } };
    const b = { p: { id: "p", x: 10, y: 0, r: 12 }, q: { id: "q", x: 5, y: 5, r: 2 }, far: { id: "far", x: 900, y: 0, r: 1 } };
    const out = lerpBodies({ ...a, far: { id: "far", x: 0, y: 0, r: 1 } }, b, 0.5);
    expect(out.map((e) => e.id)).toEqual(["p", "q", "far"]);
    expect(out[0]).toMatchObject({ x: 5, r: 10 });
    expect(out[2].x).toBe(900);
    expect(a.p.x).toBe(0); // inputs untouched
  });

  it("FixedStep: whole steps + alpha, caps catch-up", () => {
    const f = new FixedStep(100, 3);
    expect(f.advance(250)).toBe(2);
    expect(f.alpha).toBeCloseTo(0.5, 9);
    expect(f.advance(10_000)).toBe(3);
  });
});

describe("Particles pool", () => {
  it("never grows past capacity and recycles when full", () => {
    const p = new Particles(32);
    const xs = p.x;
    expect(p.emit({ x: 0, y: 0, count: 20 })).toBe(20);
    expect(p.emit({ x: 1, y: 1, count: 20, color: "#f00" })).toBe(20);
    expect(p.count).toBe(32);
    expect(p.x).toBe(xs); // same backing store: no reallocation
    expect(p.color.filter((c) => c === "#f00").length).toBe(20);
  });

  it("expired particles free their slots; live ones keep moving", () => {
    const p = new Particles(64);
    p.emit({ x: 0, y: 0, count: 10, life: 0.1, lifeJitter: 0 });
    p.emit({ x: 0, y: 0, count: 5, life: 1, lifeJitter: 0, speed: 100, speedJitter: 0, angle: 0, spread: 0, gravity: 50 });
    p.update(0.2);
    expect(p.count).toBe(5);
    for (let i = 0; i < p.count; i++) {
      expect(p.x[i]).toBeCloseTo(20, 4);
      expect(p.vy[i]).toBeCloseTo(10, 4);
    }
    p.update(1);
    expect(p.count).toBe(0);
    expect(p.emit({ x: 0, y: 0, count: 64 })).toBe(64);
  });

  it("draws additive and flat particles in two passes and restores ctx state", () => {
    const p = new Particles(8);
    p.emit({ x: 0, y: 0, count: 2, additive: false });
    const ops: string[] = [];
    const ctx = {
      globalCompositeOperation: "source-over", globalAlpha: 1, fillStyle: "",
      fillRect() { ops.push(`rect:${ctx.globalCompositeOperation}`); },
      drawImage() { ops.push("img"); },
    } as unknown as CanvasRenderingContext2D;
    p.draw(ctx);
    expect(ops).toEqual(["rect:source-over", "rect:source-over"]);
    expect([ctx.globalCompositeOperation, ctx.globalAlpha]).toEqual(["source-over", 1]);
  });
});

describe("Camera", () => {
  it("follows smoothly, frame-rate independent", () => {
    const a = new Camera(), b = new Camera();
    a.follow(100, 0); b.follow(100, 0);
    for (let i = 0; i < 60; i++) a.update(1 / 60);
    for (let i = 0; i < 30; i++) b.update(1 / 30);
    expect(a.x).toBeCloseTo(b.x, 6);
    expect(a.x).toBeGreaterThan(99);
    const c = new Camera().follow(50, 60, true);
    expect([c.x, c.y]).toEqual([50, 60]);
  });

  it("clamps to bounds and centers a world smaller than the view", () => {
    const c = new Camera().resize(800, 600);
    c.bounds = { x: 0, y: 0, w: 2000, h: 500 };
    c.follow(0, 0, true);
    expect([c.x, c.y]).toEqual([400, 250]);
    c.follow(5000, 0, true);
    expect(c.x).toBe(1600);
    c.zoom = 2;
    c.follow(0, 0, true);
    expect([c.x, c.y]).toEqual([200, 150]);
  });

  it("world<->screen round-trips; shake decays to zero", () => {
    const c = new Camera().resize(800, 600).follow(100, 100, true);
    c.zoom = 1.5;
    const s = c.worldToScreen(130, 80);
    expect(s).toEqual({ x: 445, y: 270 });
    expect(c.screenToWorld(s.x, s.y)).toEqual({ x: 130, y: 80 });
    expect(c.visible(100, 100)).toBe(true);
    expect(c.visible(1000, 100)).toBe(false);
    c.shake(10, 0.3);
    c.update(0.016);
    expect(Math.abs(c.shakeX) + Math.abs(c.shakeY)).toBeGreaterThan(0);
    expect(Math.abs(c.shakeX)).toBeLessThanOrEqual(10);
    for (let i = 0; i < 30; i++) c.update(0.016);
    expect([c.shakeX, c.shakeY]).toEqual([0, 0]);
  });
});

describe("tween + trail", () => {
  it("easings hit their endpoints", () => {
    for (const [name, f] of Object.entries(ease)) {
      expect(f(0), name).toBeCloseTo(0, 6);
      expect(f(1), name).toBeCloseTo(1, 6);
    }
    expect(tween(10, 20, 0.5, 1, ease.linear)).toBe(15);
    expect(tween(10, 20, 5, 1)).toBe(20);
    const t = new Tween(0, 1, 0.5, ease.linear);
    t.update(0.25);
    expect([t.value, t.done]).toEqual([0.5, false]);
    expect(damp(0, 10, 1000, 1)).toBeCloseTo(10, 6);
  });

  it("trail keeps the newest points and resets on teleport", () => {
    const t = new Trail(4, 1);
    for (let i = 0; i < 10; i++) t.push(i * 5, 0);
    expect(t.length).toBe(4);
    expect(t.point(0)).toEqual([45, 0]);
    expect(t.point(3)).toEqual([30, 0]);
    t.push(45.5, 0); // too close: ignored
    expect(t.point(0)).toEqual([45, 0]);
    t.push(1000, 0);
    expect(t.length).toBe(1);
  });
});

describe("Sfx", () => {
  // Minimal WebAudio stand-in: records which nodes a sound builds.
  function fakeAudio() {
    const log: string[] = [];
    const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
    const node = (kind: string) => ({ kind, connect() {}, disconnect() {}, gain: param(), frequency: param(), pan: param(), type: "", buffer: null as unknown, onended: null as null | (() => void), start() { log.push(kind); }, stop() {} });
    class Ctx {
      state = "running"; currentTime = 0; sampleRate = 8000; destination = {};
      createGain() { return node("gain"); }
      createOscillator() { return node("osc"); }
      createBufferSource() { return node("noise"); }
      createBiquadFilter() { return node("filter"); }
      createStereoPanner() { return node("pan"); }
      createBuffer(_c: number, n: number) { const d = new Float32Array(n); return { getChannelData: () => d }; }
      resume() { return Promise.resolve(); }
    }
    return { log, Ctx: Ctx as unknown as new () => AudioContext };
  }

  it("plays every named sound, rate-limits repeats, mute silences", () => {
    const { log, Ctx } = fakeAudio();
    const s = new Sfx(Ctx);
    s.maxVoices = 100; // the fake never fires onended
    for (const n of SOUND_NAMES) expect(s.play(n), n).toBe(true);
    expect(log.length).toBeGreaterThanOrEqual(SOUND_NAMES.length);
    expect(s.play("blip")).toBe(false); // same instant: deduped
    (s.ctx as unknown as { currentTime: number }).currentTime = 1;
    expect(s.play("blip", { pan: 0.5, pitch: 1.1 })).toBe(true);
    s.muted = true;
    (s.ctx as unknown as { currentTime: number }).currentTime = 2;
    expect(s.play("blip")).toBe(false);
  });

  it("is a silent no-op without WebAudio", () => {
    const s = new Sfx(undefined);
    s.unlock();
    expect(s.play("coin")).toBe(false);
  });
});
