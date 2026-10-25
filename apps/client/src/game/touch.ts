// Touch -> Input for phones and tablets, for every game (frozen core, like spectate): a floating
// joystick wherever a thumb lands, an action button bottom right and a play/watch button top
// right. Drawn on the game canvas (no DOM, nothing for the CSP to block) and only once the
// device has touch, so desktop and the stream overlay look unchanged.
import type { Input } from "@tcg/shared";

export interface Circle { x: number; y: number; r: number }
export type TouchHit = "toggle" | "action" | "stick" | null;

// Stick travel in CSS px for full speed, dead zone as a fraction of it, output step size.
const STICK_R = 56;
const DEAD = 0.18;
const STEP = 0.25;

export class TouchPad {
  enabled: boolean;
  private stick: { id: number; ox: number; oy: number; x: number; y: number } | null = null;
  private actionId: number | null = null;

  constructor(enabled = false) { this.enabled = enabled; }

  static layout(w: number, h: number): { action: Circle; toggle: Circle } {
    const r = Math.max(32, Math.min(48, Math.min(w, h) * 0.09));
    return {
      action: { x: w - r - 28, y: h - r - 36, r },
      toggle: { x: w - 34, y: 34, r: 24 },
    };
  }

  /** A finger went down at (x, y) in a w x h view. Spectating: only the play/watch button works. */
  down(id: number, x: number, y: number, w: number, h: number, spectator: boolean): TouchHit {
    this.enabled = true;
    const { action, toggle } = TouchPad.layout(w, h);
    if (inside(toggle, x, y, 12)) return "toggle";
    if (spectator) return null;
    if (inside(action, x, y, 16)) { this.actionId = id; return "action"; }
    if (this.stick) return null; // second finger elsewhere: ignore
    this.stick = { id, ox: x, oy: y, x, y };
    return "stick";
  }

  move(id: number, x: number, y: number): void {
    if (this.stick?.id === id) { this.stick.x = x; this.stick.y = y; }
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
    const { action, toggle } = TouchPad.layout(w, h);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    disc(ctx, toggle, "rgba(255,255,255,0.12)", "rgba(255,255,255,0.35)");
    ctx.fillStyle = "rgba(255,255,255,0.8)";
    ctx.font = "11px system-ui, sans-serif";
    ctx.fillText(spectator ? "play" : "watch", toggle.x, toggle.y + 1);
    if (!spectator) {
      const pressed = this.actionId !== null;
      disc(ctx, action, pressed ? "rgba(255,255,255,0.35)" : "rgba(255,255,255,0.14)", "rgba(255,255,255,0.45)");
      if (this.stick) {
        const s = this.stick, i = this.read();
        disc(ctx, { x: s.ox, y: s.oy, r: STICK_R }, "rgba(255,255,255,0.08)", "rgba(255,255,255,0.3)");
        disc(ctx, { x: s.ox + i.dx * STICK_R, y: s.oy + i.dy * STICK_R, r: 24 }, "rgba(255,255,255,0.35)", "rgba(255,255,255,0.6)");
      }
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

function disc(ctx: CanvasRenderingContext2D, c: Circle, fill: string, stroke: string): void {
  ctx.beginPath();
  ctx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
  ctx.fillStyle = fill;
  ctx.fill();
  ctx.strokeStyle = stroke;
  ctx.stroke();
}
