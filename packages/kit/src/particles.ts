// Pooled particles. Fixed capacity, struct-of-arrays storage: emitting allocates nothing, and a
// full pool recycles live particles instead of growing. Times in seconds, speeds in px/s.
//   const fx = new Particles(512);
//   fx.emit({ x, y, count: 12, color: "#ffd54a", speed: 120 });
//   fx.update(dt); fx.draw(ctx);   // inside camera.apply/reset: particles live in world space
import { glowSprite } from "./glow.js";

export interface EmitOpts {
  x: number;
  y: number;
  count?: number;
  color?: string;
  // Initial speed, px/s; each particle gets speed * (1 ± speedJitter).
  speed?: number;
  speedJitter?: number;
  // Direction (radians) and cone width. Default: full circle.
  angle?: number;
  spread?: number;
  // Inherit some velocity, px/s (e.g. the emitter's own motion).
  vx?: number;
  vy?: number;
  // Lifetime, s; each particle gets life * (1 ± lifeJitter).
  life?: number;
  lifeJitter?: number;
  // Radius, px.
  size?: number;
  // px/s² added to vy (positive = down).
  gravity?: number;
  // Fraction of velocity lost per second, 0..1+.
  drag?: number;
  // Additive glow dot (default) or a flat square.
  additive?: boolean;
  // Shrink to 0 over the lifetime (default true); otherwise only fade.
  shrink?: boolean;
}

const ADDITIVE = 1;
const SHRINK = 2;

type Sprite = ReturnType<typeof glowSprite>;

export class Particles {
  readonly capacity: number;
  // Live particles occupy slots [0, count).
  count = 0;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly life: Float32Array;
  readonly maxLife: Float32Array;
  readonly size: Float32Array;
  readonly gravity: Float32Array;
  readonly drag: Float32Array;
  readonly flags: Uint8Array;
  readonly color: string[];
  private sprite: (Sprite | null)[];
  private cursor = 0;
  private seed = 0x9e3779b9;

  constructor(capacity = 512) {
    this.capacity = capacity;
    const f = () => new Float32Array(capacity);
    this.x = f(); this.y = f(); this.vx = f(); this.vy = f();
    this.life = f(); this.maxLife = f(); this.size = f(); this.gravity = f(); this.drag = f();
    this.flags = new Uint8Array(capacity);
    this.color = new Array<string>(capacity).fill("#fff");
    this.sprite = new Array<Sprite | null>(capacity).fill(null);
  }

  // Spawn a burst. Returns how many particles were written.
  emit(o: EmitOpts): number {
    const n = Math.max(0, Math.min(o.count ?? 10, this.capacity));
    const color = o.color ?? "#ffffff";
    const additive = o.additive ?? true;
    const size = o.size ?? 3;
    const flags = (additive ? ADDITIVE : 0) | (o.shrink ?? true ? SHRINK : 0);
    const speed = o.speed ?? 80, sj = o.speedJitter ?? 0.5;
    const life = o.life ?? 0.6, lj = o.lifeJitter ?? 0.3;
    const angle = o.angle ?? 0, spread = o.spread ?? Math.PI * 2;
    for (let k = 0; k < n; k++) {
      let i: number;
      if (this.count < this.capacity) i = this.count++;
      else { i = this.cursor; this.cursor = (this.cursor + 1) % this.capacity; }
      const a = angle + (this.rand() - 0.5) * spread;
      const s = speed * (1 + (this.rand() * 2 - 1) * sj);
      this.x[i] = o.x; this.y[i] = o.y;
      this.vx[i] = Math.cos(a) * s + (o.vx ?? 0);
      this.vy[i] = Math.sin(a) * s + (o.vy ?? 0);
      this.life[i] = this.maxLife[i] = Math.max(0.01, life * (1 + (this.rand() * 2 - 1) * lj));
      this.size[i] = size;
      this.gravity[i] = o.gravity ?? 0;
      this.drag[i] = o.drag ?? 0;
      this.flags[i] = flags;
      this.color[i] = color;
      this.sprite[i] = null; // resolved on first draw, so emit/update never touch the canvas API
    }
    return n;
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.count) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) { this.kill(i); continue; } // slot i now holds the last particle: revisit it
      const k = this.drag[i] > 0 ? Math.max(0, 1 - this.drag[i] * dt) : 1;
      this.vy[i] += this.gravity[i] * dt;
      this.vx[i] *= k; this.vy[i] *= k;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      i++;
    }
  }

  draw(ctx: CanvasRenderingContext2D): void {
    if (!this.count) return;
    const op = ctx.globalCompositeOperation;
    const alpha = ctx.globalAlpha;
    // Two passes keep composite-mode switches to two per frame.
    for (let pass = 0; pass < 2; pass++) {
      ctx.globalCompositeOperation = pass === 0 ? op : "lighter";
      for (let i = 0; i < this.count; i++) {
        const f = this.flags[i];
        if ((f & ADDITIVE ? 1 : 0) !== pass) continue;
        const t = this.life[i] / this.maxLife[i];
        const r = f & SHRINK ? this.size[i] * t : this.size[i];
        if (r <= 0.05) continue;
        ctx.globalAlpha = alpha * t;
        const s = pass ? (this.sprite[i] ??= glowSprite(this.color[i], this.size[i] * 2)) : null;
        if (s) ctx.drawImage(s, this.x[i] - r * 2, this.y[i] - r * 2, r * 4, r * 4);
        else { ctx.fillStyle = this.color[i]; ctx.fillRect(this.x[i] - r, this.y[i] - r, r * 2, r * 2); }
      }
    }
    ctx.globalAlpha = alpha;
    ctx.globalCompositeOperation = op;
  }

  clear(): void { this.count = 0; this.cursor = 0; }

  // Swap-remove: move the last live particle into slot i.
  private kill(i: number): void {
    const j = --this.count;
    if (i === j) return;
    this.x[i] = this.x[j]; this.y[i] = this.y[j]; this.vx[i] = this.vx[j]; this.vy[i] = this.vy[j];
    this.life[i] = this.life[j]; this.maxLife[i] = this.maxLife[j]; this.size[i] = this.size[j];
    this.gravity[i] = this.gravity[j]; this.drag[i] = this.drag[j]; this.flags[i] = this.flags[j];
    this.color[i] = this.color[j]; this.sprite[i] = this.sprite[j];
  }

  // Visual-only noise (xorshift32): deterministic for tests, no Math.random.
  private rand(): number {
    let s = this.seed;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.seed = s;
    return (s >>> 0) / 4294967296;
  }
}
