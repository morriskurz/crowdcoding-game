// Halo/glow sprites: radial gradients pre-rendered once into offscreen canvases, then stamped
// with drawImage under globalCompositeOperation "lighter" (additive: overlaps get brighter).
// Far cheaper than ctx.shadowBlur, and no per-frame gradient objects.
//   drawGlow(ctx, e.x, e.y, e.r * 3, "#7dd3fc", 0.6);

type Canvas = HTMLCanvasElement | OffscreenCanvas;
type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const cache = new Map<string, Canvas>();
const MAX_CACHE = 128;

export function makeCanvas(w: number, h: number): Canvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

// Pre-render something once and reuse it as an image: makeSprite(32, 32, (g) => { ... }).
export function makeSprite(w: number, h: number, draw: (g: Ctx2D) => void): Canvas {
  const c = makeCanvas(Math.max(1, Math.ceil(w)), Math.max(1, Math.ceil(h)));
  draw(c.getContext("2d") as Ctx2D);
  return c;
}

// Cached glow sprite for a color. Sprites are rendered at a fixed size per power-of-two bucket and
// scaled at draw time, so any radius reuses a handful of canvases. `falloff` 0..1: higher = softer edge.
export function glowSprite(color: string, radius = 32, falloff = 0.5): Canvas {
  const size = Math.min(256, Math.max(8, 2 ** Math.ceil(Math.log2(Math.max(1, radius)))));
  const key = `${color}|${size}|${falloff}`;
  let c = cache.get(key);
  if (!c) {
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
    c = makeSprite(size * 2, size * 2, (g) => {
      const grad = g.createRadialGradient(size, size, 0, size, size, size);
      grad.addColorStop(0, color);
      grad.addColorStop(Math.max(0.05, 1 - falloff) * 0.5, color);
      grad.addColorStop(1, "rgba(0,0,0,0)");
      g.fillStyle = grad;
      g.fillRect(0, 0, size * 2, size * 2);
    });
    cache.set(key, c);
  }
  return c;
}

// Additive glow of `radius` px centered on (x, y).
export function drawGlow(ctx: CanvasRenderingContext2D, x: number, y: number, radius: number, color: string, alpha = 1, falloff = 0.5): void {
  if (radius <= 0 || alpha <= 0) return;
  const op = ctx.globalCompositeOperation;
  const a = ctx.globalAlpha;
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = a * alpha;
  ctx.drawImage(glowSprite(color, radius, falloff), x - radius, y - radius, radius * 2, radius * 2);
  ctx.globalAlpha = a;
  ctx.globalCompositeOperation = op;
}

// Run `fn` with additive blending, restoring the previous mode after.
export function additive(ctx: CanvasRenderingContext2D, fn: () => void): void {
  const op = ctx.globalCompositeOperation;
  ctx.globalCompositeOperation = "lighter";
  try { fn(); } finally { ctx.globalCompositeOperation = op; }
}
