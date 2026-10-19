// Motion trail: a ring buffer of recent positions drawn as a tapering, fading ribbon.
//   const t = new Trail(16); each frame: t.push(e.x, e.y); t.draw(ctx, { color: "#7dd3fc", width: e.r });

export interface TrailStyle {
  color?: string;
  // Width at the head, px. Tapers to 0 at the tail.
  width?: number;
  // Head opacity, 0..1. Fades to 0 at the tail.
  alpha?: number;
  // Draw with "lighter" blending.
  additive?: boolean;
}

export class Trail {
  readonly max: number;
  private xs: Float32Array;
  private ys: Float32Array;
  private head = 0;
  // Points stored, <= max.
  length = 0;

  // `minDist`: skip points closer than this to the last one, so standing still does not collapse the trail.
  constructor(max = 16, public minDist = 2) {
    this.max = Math.max(2, max);
    this.xs = new Float32Array(this.max);
    this.ys = new Float32Array(this.max);
  }

  push(x: number, y: number): void {
    if (this.length) {
      const [lx, ly] = this.point(0);
      const dx = x - lx, dy = y - ly;
      if (dx * dx + dy * dy < this.minDist * this.minDist) return;
      // Teleport/respawn: start a fresh trail rather than drawing a streak across the map.
      if (dx * dx + dy * dy > 200 * 200) this.clear();
    }
    this.head = (this.head + 1) % this.max;
    this.xs[this.head] = x; this.ys[this.head] = y;
    if (this.length < this.max) this.length++;
  }

  // i = 0 is the newest point.
  point(i: number): [number, number] {
    const k = (this.head - i + this.max * 2) % this.max;
    return [this.xs[k], this.ys[k]];
  }

  // Lose the oldest point (call when the body is still, so the trail shrinks away).
  shrink(): void { if (this.length) this.length--; }

  clear(): void { this.length = 0; }

  draw(ctx: CanvasRenderingContext2D, s: TrailStyle = {}): void {
    if (this.length < 2) return;
    const width = s.width ?? 4;
    const alpha = s.alpha ?? 0.6;
    const op = ctx.globalCompositeOperation;
    const a0 = ctx.globalAlpha;
    if (s.additive) ctx.globalCompositeOperation = "lighter";
    ctx.strokeStyle = s.color ?? "#ffffff";
    ctx.lineCap = "round";
    let [px, py] = this.point(0);
    for (let i = 1; i < this.length; i++) {
      const [x, y] = this.point(i);
      const t = 1 - i / this.length;
      ctx.globalAlpha = a0 * alpha * t;
      ctx.lineWidth = Math.max(0.5, width * t);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(x, y);
      ctx.stroke();
      px = x; py = y;
    }
    ctx.globalAlpha = a0;
    ctx.globalCompositeOperation = op;
  }
}
