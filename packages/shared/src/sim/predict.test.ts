import { describe, it, expect } from "vitest";
import {
  InputAcks, Predictor, bodies, createWorld, joinPlayer, packInput, random, runTick, snapMessage, spawn, stepPhysics,
  type GameRules, type Input, type SnapMessage, type World,
} from "../index.js";

// Platformer with collisions between players, RNG spawns and despawns: every path that could
// make a client replay diverge from the server.
const rules: GameRules = {
  init(w) { for (let i = 0; i < 6; i++) spawn(w, { kind: "crate", x: random(w) * 400, y: random(w) * 100, r: 6 }); },
  join(w, id) { spawn(w, { id, kind: "player", x: 60 + Object.keys(w.names).length * 30, y: 50, r: 10 }); },
  step(w, inputs) {
    for (const p of bodies(w, "player")) {
      const inp = inputs[p.id];
      p.vx = (inp?.dx ?? 0) * 4;
      if (inp?.action && p.ground) p.vy = -12;
    }
    stepPhysics(bodies(w), { gravity: 0.6, drag: 0.01, bounce: 0.2, bounds: { x: 0, y: 0, w: 400, h: 300 }, solids: [{ x: 120, y: 200, w: 80, h: 8 }] });
    if (w.tick % 13 === 0) spawn(w, { kind: "crate", x: random(w) * 400, y: 0, r: 5 });
    const crates = bodies(w, "crate");
    if (crates.length > 12) delete w.entities[crates[0].id];
  },
};

// Server loop exactly as room.ts runs it.
class Server {
  w: World = createWorld(77);
  inputs: Record<string, Input> = {};
  acks = new InputAcks();
  history = new Map<number, string>();
  constructor() { rules.init!(this.w); }
  join(id: string) { joinPlayer(this.w, rules, id, id); this.inputs[id] = { dx: 0, dy: 0, action: false }; this.acks.join(id); }
  receive(id: string, m: Input & { seq?: number }) {
    if (this.acks.received(id, m.seq)) this.inputs[id] = { dx: m.dx, dy: m.dy, action: m.action };
  }
  tick(): SnapMessage {
    runTick(this.w, rules, this.inputs);
    this.acks.ticked(Object.keys(this.inputs));
    const inputs = Object.fromEntries(Object.entries(this.inputs).map(([k, v]) => [k, packInput(v)]));
    const snap = JSON.parse(JSON.stringify(snapMessage(this.w, "v", false, { acks: this.acks.acks, inputs })));
    this.history.set(this.w.tick, JSON.stringify(snap.entities));
    return snap;
  }
}

// Client input script: changes every few ticks, jumps sometimes.
const script = (t: number): Input => ({ dx: [1, 1, 0, -1, -1, 1][Math.floor(t / 7) % 6], dy: 0, action: t % 23 < 2 });
const same = (a: Input, b: Input) => a.dx === b.dx && a.dy === b.dy && a.action === b.action;

interface NetOpts { up: (t: number) => number; down: (t: number) => number; drop?: (t: number) => boolean; ticks?: number }

// Lockstep network simulation: one server tick and one client tick per step, messages delayed by
// whole steps. Returns, for every predicted tick, whether the client's own entity matched the
// server's state at that tick (predictions run ahead, so the server keeps ticking at the end).
function exactness(o: NetOpts) {
  const s = new Server();
  s.join("bot");
  s.receive("bot", { dx: -1, dy: 0, action: true });
  s.join("me");
  const p = new Predictor(rules, "me");
  const toServer: { at: number; m: Input & { seq: number } }[] = [];
  const toClient: { at: number; m: SnapMessage }[] = [];
  const predicted: [number, string][] = [];
  let seq = 1, sent: Input | null = null, started = false;
  const N = o.ticks ?? 400;
  for (let t = 0; t < N + 20; t++) {
    for (const x of toServer.filter((x) => x.at === t)) s.receive("me", x.m);
    toClient.push({ at: t + o.down(t), m: s.tick() });
    if (t >= N) continue; // let the server run ahead so every prediction can be checked
    for (const x of toClient.filter((x) => x.at === t)) { p.reconcile(x.m); started = true; }
    if (!started) continue;
    const input = script(t);
    if (!sent || !same(input, sent)) {
      seq++;
      sent = input;
      if (!o.drop?.(t)) toServer.push({ at: t + o.up(t), m: { ...input, seq } });
    }
    p.step(input, seq);
    predicted.push([p.world!.tick, JSON.stringify(p.world!.entities)]);
  }
  return predicted.map(([tick, me]) => ({ tick, ok: s.history.get(tick) === me }));
}

describe("prediction", () => {
  it("InputAcks counts consecutive ticks per seq and ignores stale seqs", () => {
    const a = new InputAcks();
    a.join("p");
    a.ticked(["p"]); a.ticked(["p"]);
    expect(a.acks.p).toEqual([0, 2]);
    expect(a.received("p", 3)).toBe(true);
    expect(a.received("p", 2)).toBe(false);
    a.ticked(["p"]);
    expect(a.acks.p).toEqual([3, 1]);
    expect(a.received("p", undefined)).toBe(true);
    a.leave("p");
    expect(a.acks.p).toBeUndefined();
  });

  it("is exact under constant latency: every predicted tick equals the server's state", () => {
    for (const [up, down] of [[1, 1], [2, 3], [5, 4]]) {
      const r = exactness({ up: () => up, down: () => down });
      // The first round trip has no ack for our first input yet; after that, bit-identical.
      const settled = r.slice(up + down + 2);
      expect(settled.length).toBeGreaterThan(300);
      expect(settled.every((x) => x.ok), `up=${up} down=${down}`).toBe(true);
    }
  });

  it("recovers exactness after jitter and dropped inputs", () => {
    const r = exactness({
      up: (t) => (t < 200 ? 2 + (t % 3) : 2),
      down: (t) => (t < 200 ? 1 + ((t * 7) % 4) : 2),
      drop: (t) => t < 200 && t % 5 === 0,
    });
    const late = r.filter((x) => x.tick > 260);
    expect(late.length).toBeGreaterThan(100);
    expect(late.every((x) => x.ok)).toBe(true);
    // And the disturbed part was actually disturbed (the test exercises reconciliation).
    expect(r.filter((x) => x.tick < 200).some((x) => !x.ok)).toBe(true);
  });

  it("replaying pending frames onto a snapshot equals running the server forward", () => {
    const s = new Server();
    s.join("me");
    const snap = s.tick();
    const p = new Predictor(rules, "me");
    // Frames the server has not seen yet.
    for (let i = 0; i < 5; i++) p.step(script(i), 2 + i);
    p.reconcile(snap);
    expect(p.pending.length).toBe(5);
    for (let i = 0; i < 5; i++) { s.receive("me", { ...script(i), seq: 2 + i }); s.tick(); }
    expect(JSON.stringify(p.world!.entities)).toBe(JSON.stringify(JSON.parse(JSON.stringify(s.w.entities))));
    expect([p.world!.tick, p.world!.rng, p.world!.nextId]).toEqual([s.w.tick, s.w.rng, s.w.nextId]);
  });

  it("drops confirmed frames, caps pending, and disables itself without acks", () => {
    const p = new Predictor(rules, "me", 10);
    for (let i = 0; i < 25; i++) p.step({ dx: 1, dy: 0, action: false }, 1);
    expect(p.pending.length).toBe(10);
    const s = new Server();
    s.join("me");
    const snap = s.tick();
    snap.acks = { me: [1, 4] };
    p.reconcile(snap);
    expect(p.pending.length).toBe(6);
    snap.acks = { me: [1, 7] };
    p.reconcile(snap);
    expect(p.pending.length).toBe(3); // 3 more dropped, not 7
    delete snap.acks;
    expect(p.reconcile(snap)).toBe(false);
    expect(p.pending.length).toBe(0);
  });
});
