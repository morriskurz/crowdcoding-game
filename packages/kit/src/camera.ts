// 2D camera: smooth follow, clamp to world bounds, screen shake.
//   cam.resize(w, h); cam.follow(me.x, me.y); cam.update(dt);
//   cam.apply(ctx); ...draw world...; cam.reset(ctx);
// x/y is the world point at the center of the screen.
import { clamp, damp } from "./tween.js";

export interface Bounds { x: number; y: number; w: number; h: number }

export class Camera {
  x = 0;
  y = 0;
  zoom = 1;
  // Viewport in CSS pixels.
  viewW = 800;
  viewH = 600;
  // Follow smoothing (higher = tighter). 0 = snap.
  stiffness = 8;
  // World area the view may show; null = unbounded.
  bounds: Bounds | null = null;
  // Current shake offset, recomputed by update().
  shakeX = 0;
  shakeY = 0;
  private tx = 0;
  private ty = 0;
  private trauma = 0;
  private shakeMax = 0;
  private shakeDecay = 1;
  private seed = 1;

  resize(w: number, h: number): this { this.viewW = w; this.viewH = h; return this; }

  // Set the point to follow. `snap` jumps there immediately (spawn, teleport).
  follow(x: number, y: number, snap = false): this {
    this.tx = x; this.ty = y;
    if (snap) { this.x = x; this.y = y; this.clampToBounds(); }
    return this;
  }

  // Shake with `intensity` px for about `duration` s. Overlapping shakes keep the stronger one.
  shake(intensity: number, duration = 0.3): this {
    this.shakeMax = Math.max(this.shakeMax * this.trauma, intensity);
    this.trauma = 1;
    this.shakeDecay = 1 / Math.max(duration, 1e-3);
    return this;
  }

  update(dt: number): this {
    if (this.stiffness <= 0) { this.x = this.tx; this.y = this.ty; }
    else { this.x = damp(this.x, this.tx, this.stiffness, dt); this.y = damp(this.y, this.ty, this.stiffness, dt); }
    this.clampToBounds();
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - dt * this.shakeDecay);
      const amp = this.shakeMax * this.trauma * this.trauma;
      this.shakeX = (this.rand() * 2 - 1) * amp;
      this.shakeY = (this.rand() * 2 - 1) * amp;
    } else { this.shakeX = 0; this.shakeY = 0; }
    return this;
  }

  // Keep the view inside bounds; a world smaller than the view is centered.
  clampToBounds(): void {
    const b = this.bounds;
    if (!b) return;
    const hw = this.viewW / 2 / this.zoom;
    const hh = this.viewH / 2 / this.zoom;
    this.x = b.w <= hw * 2 ? b.x + b.w / 2 : clamp(this.x, b.x + hw, b.x + b.w - hw);
    this.y = b.h <= hh * 2 ? b.y + b.h / 2 : clamp(this.y, b.y + hh, b.y + b.h - hh);
  }

  // Multiply world transform onto ctx (call after setting the DPR transform). Pair with reset().
  apply(ctx: CanvasRenderingContext2D): void {
    ctx.save();
    ctx.translate(Math.round(this.viewW / 2 + this.shakeX), Math.round(this.viewH / 2 + this.shakeY));
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x, -this.y);
  }

  reset(ctx: CanvasRenderingContext2D): void { ctx.restore(); }

  worldToScreen(wx: number, wy: number): { x: number; y: number } {
    return { x: (wx - this.x) * this.zoom + this.viewW / 2 + this.shakeX, y: (wy - this.y) * this.zoom + this.viewH / 2 + this.shakeY };
  }

  screenToWorld(sx: number, sy: number): { x: number; y: number } {
    return { x: (sx - this.viewW / 2 - this.shakeX) / this.zoom + this.x, y: (sy - this.viewH / 2 - this.shakeY) / this.zoom + this.y };
  }

  // True if a circle at (x, y, r) is on screen: skip drawing what you cannot see.
  visible(x: number, y: number, r = 0): boolean {
    const hw = this.viewW / 2 / this.zoom + r;
    const hh = this.viewH / 2 / this.zoom + r;
    return Math.abs(x - this.x) <= hw && Math.abs(y - this.y) <= hh;
  }

  // Shake noise only (visual): xorshift, so the camera has no Math.random dependency.
  private rand(): number {
    let s = this.seed;
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    this.seed = s;
    return (s >>> 0) / 4294967296;
  }
}
