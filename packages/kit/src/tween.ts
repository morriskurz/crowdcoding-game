// Math + tween helpers. Pure, no DOM. All times in seconds.

export type Ease = (t: number) => number;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
// Inverse of lerp: where v sits between a and b (0..1, unclamped).
export const unlerp = (a: number, b: number, v: number): number => (a === b ? 0 : (v - a) / (b - a));

// Frame-rate independent exponential smoothing: move `current` toward `target`, losing
// `1 - e^(-rate*dt)` of the gap each call. rate ~10 = snappy, ~3 = floaty.
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-rate * dt));

// Shortest-path angle lerp (radians).
export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  else if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

export const ease = {
  linear: (t: number) => t,
  inQuad: (t: number) => t * t,
  outQuad: (t: number) => t * (2 - t),
  inOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  outCubic: (t: number) => 1 - (1 - t) ** 3,
  inOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  outBack: (t: number) => 1 + 2.70158 * (t - 1) ** 3 + 1.70158 * (t - 1) ** 2,
  outElastic: (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1),
  outBounce: (t: number) => {
    const n = 7.5625, d = 2.75;
    if (t < 1 / d) return n * t * t;
    if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
    if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
    return n * (t -= 2.625 / d) * t + 0.984375;
  },
} satisfies Record<string, Ease>;

// Eased value of a from->to animation `elapsed` seconds into `duration`.
export function tween(from: number, to: number, elapsed: number, duration: number, fn: Ease = ease.outQuad): number {
  return lerp(from, to, fn(clamp(duration > 0 ? elapsed / duration : 1, 0, 1)));
}

// A running tween you keep and update each frame.
//   const pop = new Tween(1, 1.4, 0.2, ease.outBack); ... pop.update(dt); scale = pop.value;
export class Tween {
  elapsed = 0;
  constructor(public from: number, public to: number, public duration: number, public fn: Ease = ease.outQuad) {}
  get value(): number { return tween(this.from, this.to, this.elapsed, this.duration, this.fn); }
  get done(): boolean { return this.elapsed >= this.duration; }
  update(dt: number): number { this.elapsed += dt; return this.value; }
  restart(from = this.from, to = this.to): this { this.from = from; this.to = to; this.elapsed = 0; return this; }
}

// 0..1..0 pulse with the given period: handy for blinking/breathing.
export const pulse = (time: number, period = 1): number => 0.5 - 0.5 * Math.cos((time / period) * Math.PI * 2);
