// Snapshot interpolation: the server ticks at 15 Hz, the screen runs at 60+ Hz.
// Keep the last few snapshots and draw the world slightly in the past (`delay` ticks),
// blending between the two snapshots around that time.
//   buf.push(snap.tick, snap.entities, performance.now());
//   const s = buf.sample(performance.now());
//   if (s) for (const e of lerpBodies(s.a, s.b, s.t)) draw(e);
import { lerp } from "./tween.js";

export interface Body { id: string; x: number; y: number; r?: number }

export interface Sample<S> {
  a: S;
  b: S;
  // Blend factor a -> b, 0..1.
  t: number;
  // Fractional server tick being shown.
  tick: number;
}

export interface BufferOpts {
  // Server tick rate.
  hz?: number;
  // How far behind the newest estimated server tick to render. 2 ticks absorbs one lost/late packet.
  delay?: number;
  // Snapshots kept.
  size?: number;
}

export class SnapshotBuffer<S> {
  readonly tickMs: number;
  delay: number;
  private size: number;
  private ticks: number[] = [];
  private states: S[] = [];
  // Estimated (local time - server tick time), ms. null until the first push.
  private offset: number | null = null;

  constructor(opts: BufferOpts = {}) {
    this.tickMs = 1000 / (opts.hz ?? 15);
    this.delay = opts.delay ?? 2;
    this.size = Math.max(2, opts.size ?? 16);
  }

  get length(): number { return this.ticks.length; }
  get newest(): S | undefined { return this.states[this.states.length - 1]; }
  get newestTick(): number { return this.ticks.length ? this.ticks[this.ticks.length - 1] : -1; }

  // Add a snapshot received at local time `now` (ms). Out-of-order and duplicate ticks are dropped.
  push(tick: number, state: S, now: number): void {
    const n = this.ticks.length;
    if (n && tick <= this.ticks[n - 1]) {
      // Tick went backwards a lot: the room restarted. Start over.
      if (this.ticks[n - 1] - tick > 30) this.clear();
      else return;
    }
    this.ticks.push(tick);
    this.states.push(state);
    if (this.ticks.length > this.size) { this.ticks.shift(); this.states.shift(); }
    const sample = now - tick * this.tickMs;
    if (this.offset === null || Math.abs(sample - this.offset) > 1000) this.offset = sample;
    // Early packets pull the clock in fast, late ones push it out slowly: jitter does not drift the view.
    else this.offset = lerp(this.offset, sample, sample < this.offset ? 0.2 : 0.02);
  }

  // Estimated server tick at local time `now` (fractional), without the render delay.
  serverTick(now: number): number {
    return this.offset === null ? -1 : (now - this.offset) / this.tickMs;
  }

  // The pair of snapshots to blend at local time `now`. Holds the newest one when starved.
  sample(now: number): Sample<S> | null {
    const n = this.ticks.length;
    if (!n) return null;
    const tick = this.serverTick(now) - this.delay;
    if (n === 1 || tick <= this.ticks[0]) return { a: this.states[0], b: this.states[0], t: 0, tick: this.ticks[0] };
    if (tick >= this.ticks[n - 1]) return { a: this.states[n - 1], b: this.states[n - 1], t: 0, tick: this.ticks[n - 1] };
    let i = n - 2;
    while (i > 0 && this.ticks[i] > tick) i--;
    const t0 = this.ticks[i], t1 = this.ticks[i + 1];
    return { a: this.states[i], b: this.states[i + 1], t: (tick - t0) / (t1 - t0), tick };
  }

  clear(): void { this.ticks = []; this.states = []; this.offset = null; }
}

// Blend two id-keyed body maps. Bodies only in `b` appear as-is, bodies only in `a` are gone.
// A move longer than `maxJump` (respawn, teleport) snaps instead of sliding across the map.
export function lerpBodies<T extends Body>(a: Readonly<Record<string, T>>, b: Readonly<Record<string, T>>, t: number, maxJump = 200): T[] {
  const out: T[] = [];
  for (const id in b) {
    const eb = b[id];
    const ea = a[id];
    if (!ea || ea === eb || t >= 1) { out.push(eb); continue; }
    const dx = eb.x - ea.x, dy = eb.y - ea.y;
    if (dx * dx + dy * dy > maxJump * maxJump) { out.push(eb); continue; }
    const e = { ...eb, x: ea.x + dx * t, y: ea.y + dy * t };
    if (ea.r !== undefined && eb.r !== undefined) e.r = lerp(ea.r, eb.r, t);
    out.push(e);
  }
  return out;
}

// Fixed-timestep accumulator for running a 15 Hz sim inside a requestAnimationFrame loop.
//   const steps = clock.advance(dt); for (let i = 0; i < steps; i++) tick(); draw(clock.alpha);
export class FixedStep {
  acc = 0;
  constructor(public stepMs = 1000 / 15, public maxSteps = 5) {}
  // Feed elapsed ms, get the number of whole steps to run now.
  advance(ms: number): number {
    this.acc += ms;
    let n = Math.floor(this.acc / this.stepMs);
    this.acc -= n * this.stepMs;
    if (n > this.maxSteps) n = this.maxSteps; // tab was in background: do not spiral
    return n;
  }
  // Progress into the next step, 0..1: blend previous -> current state by this.
  get alpha(): number { return this.acc / this.stepMs; }
}
