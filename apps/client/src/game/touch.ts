// Touch -> Input for phones and tablets, for every game (frozen core, like spectate): a joystick
// that rests bottom left and jumps to wherever a thumb lands, an action button bottom right and a
// play/watch button top right. Drawn on the game canvas (no DOM, nothing for the CSP to block) and
// only once the device has touch, so desktop and the stream overlay look unchanged.
import type { Input } from "@tcg/shared";

export interface Circle { x: number; y: number; r: number }
export interface Rect { x: number; y: number; w: number; h: number }
export type TouchHit = "toggle" | "action" | "stick" | null;

// Stick travel in CSS px for full speed, dead zone as a fraction of it, output step size.
const STICK_R = 56;
const KNOB_R = 26;
const DEAD = 0.18;
const STEP = 0.25;
const ACCENT = "56,189,248"; // sky-400, as r,g,b for rgba()
const BACKING = "rgba(11,14,20,0.55)";
const RIM = "rgba(255,255,255,0.32)";

export class TouchPad {
  enabled: boolean;
  private stick: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  private actionId: number | null = null;
  // Hints ("drag to move", the action label) show until the player has used each control once.
  private usedStick = false;
  private usedAction = false;

  constructor(enabled = false) { this.enabled = enabled; }

  /** Where the controls sit in a w x h view: the stick rests bottom left until a thumb moves it. */
  static layout(w: number, h: number): { action: Circle; toggle: Rect; home: Circle } {
    const r = Math.max(34, Math.min(46, Math.min(w, h) * 0.1));
    const pad = Math.max(24, Math.min(w, h) * 0.06);
    return {
      action: { x: w - r - pad, y: h - r - pad - 12, r },
      toggle: { x: w - 96 - 12, y: 12, w: 96, h: 34 },
      home: { x: STICK_R + pad, y: h - STICK_R - pad - 12, r: STICK_R },
    };
  }

  /** A finger went down at (x, y) in a w x h view. Spectating: only the play/watch button works. */
  down(id: number, x: number, y: number, w: number, h: number, spectator: boolean): TouchHit {
    this.enabled = true;
    const { action, toggle } = TouchPad.layout(w, h);
    if (x >= toggle.x - 10 && x <= toggle.x + toggle.w + 10 && y >= toggle.y - 10 && y <= toggle.y + toggle.h + 10) return "toggle";
    if (spectator) return null;
    if (inside(action, x, y, 16)) { this.actionId = id; this.usedAction = true; return "action"; }
    if (this.stick) return null; // second finger elsewhere: ignore
    this.stick = { id, ox: x, oy: y, x, y };
    return "stick";
  }

  move(id: number, x: number, y: number): void {
    if (this.stick?.id !== id) return;
    this.stick.x = x; this.stick.y = y;
    if (this.read().dx || this.read().dy) this.usedStick = true;
  }

  up(id: number): void {
    if (this.stick?.id === id) this.stick = null;
    if (this.actionId === id) this.actionId = null;
  }

  clear(): void { this.stick = null; this.actionId = null; }

  /** Current input. dx/dy are analog in [-1, 1], snapped to STEP so tiny thumb jitter sends nothing new. */
  read(): Input {
    let dx = 0, dy = 0;
    if (this.stick) {
      const vx = (this.stick.x - this.stick.ox) / STICK_R, vy = (this.stick.y - this.stick.oy) / STICK_R;
      const len = Math.hypot(vx, vy);
      if (len > DEAD) {
        const k = Math.min(1, len) / len;
        dx = snap(vx * k);
        dy = snap(vy * k);
      }
    }
    return { dx, dy, action: this.actionId !== null };
  }

  draw(ctx: CanvasRenderingContext2D, w: number, h: number, spectator: boolean): void {
    if (!this.enabled) return;
    const { action, toggle, home } = TouchPad.layout(w, h);
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    drawToggle(ctx, toggle, spectator);
    if (!spectator) {
      // Stick: resting at home, or under the thumb with the knob following it (smooth, not snapped).
      const s = this.stick;
      const base = s ? { x: s.ox, y: s.oy, r: STICK_R } : home;
      let kx = 0, ky = 0;
      if (s) {
        const vx = s.x - s.ox, vy = s.y - s.oy, len = Math.hypot(vx, vy);
        const k = len > STICK_R ? STICK_R / len : 1;
        kx = vx * k; ky = vy * k;
      }
      drawStick(ctx, base, kx, ky, s !== null);
      if (!this.usedStick && !s) hint(ctx, "drag to move", home.x, home.y + STICK_R + 16);
      drawAction(ctx, action, this.actionId !== null);
      if (!this.usedAction) hint(ctx, "action", action.x, action.y + action.r + 16);
    }
    ctx.restore();
  }
}

/** Keyboard and touch together: the stick wins when it is pushed, action if either presses it. */
export function mergeInput(keys: Input, touch: Input): Input {
  const stick = touch.dx !== 0 || touch.dy !== 0;
  return { dx: stick ? touch.dx : keys.dx, dy: stick ? touch.dy : keys.dy, action: keys.action || touch.action };
}

const snap = (v: number) => Math.max(-1, Math.min(1, Math.round(v / STEP) * STEP)) || 0;
const inside = (c: Circle, x: number, y: number, slack = 0) => (x - c.x) ** 2 + (y - c.y) ** 2 <= (c.r + slack) ** 2;

function shadow(ctx: CanvasRenderingContext2D, on: boolean): void {
  ctx.shadowColor = on ? "rgba(0,0,0,0.5)" : "transparent";
  ctx.shadowBlur = on ? 14 : 0;
  ctx.shadowOffsetY = on ? 3 : 0;
}

function ring(ctx: CanvasRenderingContext2D, c: Circle, fill: string | CanvasGradient, stroke: string, width = 2): void {
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.lineWidth = width;
  ctx.strokeStyle = stroke;
  ctx.stroke();
}

function drawStick(ctx: CanvasRenderingContext2D, base: Circle, kx: number, ky: number, active: boolean): void {
  ctx.globalAlpha = active ? 1 : 0.75;
  shadow(ctx, true);
  ring(ctx, base, BACKING, active ? `rgba(${ACCENT},0.7)` : RIM);
  shadow(ctx, false);
  // Direction ticks: four small chevrons inside the rim.
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2, d = base.r - 12, cx = base.x + Math.cos(a) * d, cy = base.y + Math.sin(a) * d;
    const ux = Math.cos(a), uy = Math.sin(a);
    ctx.beginPath();
    ctx.moveTo(cx - ux * 4 - uy * 5, cy - uy * 4 + ux * 5);
    ctx.lineTo(cx + ux * 2, cy + uy * 2);
    ctx.lineTo(cx - ux * 4 + uy * 5, cy - uy * 4 - ux * 5);
    ctx.stroke();
  }
  const k = { x: base.x + kx, y: base.y + ky, r: KNOB_R };
  const g = ctx.createRadialGradient(k.x - 8, k.y - 10, 2, k.x, k.y, k.r);
  g.addColorStop(0, "rgba(255,255,255,0.95)");
  g.addColorStop(1, active ? `rgba(${ACCENT},0.85)` : "rgba(200,210,225,0.7)");
  shadow(ctx, true);
  ring(ctx, k, g, "rgba(255,255,255,0.9)", 1.5);
  shadow(ctx, false);
  ctx.globalAlpha = 1;
}

function drawAction(ctx: CanvasRenderingContext2D, c: Circle, pressed: boolean): void {
  const b = { ...c, r: pressed ? c.r * 0.92 : c.r };
  if (pressed) { ctx.shadowColor = `rgba(${ACCENT},0.8)`; ctx.shadowBlur = 24; } else shadow(ctx, true);
  const g = ctx.createRadialGradient(b.x - b.r * 0.3, b.y - b.r * 0.4, 2, b.x, b.y, b.r);
  g.addColorStop(0, `rgba(${ACCENT},${pressed ? 0.95 : 0.75})`);
  g.addColorStop(1, `rgba(${ACCENT},${pressed ? 0.7 : 0.4})`);
  ring(ctx, b, g, "rgba(255,255,255,0.75)", 2.5);
  shadow(ctx, false);
  // Inner ring + a bold dot: a generic "do it" glyph, since games decide what action means.
  ring(ctx, { x: b.x, y: b.y, r: b.r * 0.62 }, "transparent", "rgba(255,255,255,0.45)", 1.5);
  ring(ctx, { x: b.x, y: b.y, r: b.r * 0.22 }, "rgba(255,255,255,0.95)", "transparent", 0);
}

function drawToggle(ctx: CanvasRenderingContext2D, r: Rect, spectator: boolean): void {
  shadow(ctx, true);
  ctx.beginPath();
  if (typeof ctx.roundRect === "function") ctx.roundRect(r.x, r.y, r.w, r.h, r.h / 2); else ctx.rect(r.x, r.y, r.w, r.h); // Safari < 16
  ctx.fillStyle = BACKING;
  ctx.fill();
  shadow(ctx, false);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = RIM;
  ctx.stroke();
  const ix = r.x + 22, iy = r.y + r.h / 2;
  ctx.fillStyle = ctx.strokeStyle = "rgba(255,255,255,0.9)";
  if (spectator) {
    // Play triangle.
    ctx.beginPath();
    ctx.moveTo(ix - 5, iy - 7); ctx.lineTo(ix + 7, iy); ctx.lineTo(ix - 5, iy + 7); ctx.closePath();
    ctx.fill();
  } else {
    // Eye.
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(ix - 9, iy);
    ctx.quadraticCurveTo(ix, iy - 9, ix + 9, iy);
    ctx.quadraticCurveTo(ix, iy + 9, ix - 9, iy);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(ix, iy, 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.font = "600 13px system-ui, sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(spectator ? "Play" : "Watch", ix + 16, iy + 1);
  ctx.textAlign = "center";
}

function hint(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.font = "12px system-ui, sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillText(text, x, y);
}
