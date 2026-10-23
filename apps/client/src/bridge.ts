// postMessage bridge between the host page (owns the WebSocket) and the sandboxed game page
// (agent-written game code, opaque origin, no network of its own in practice).
// Everything that crosses is validated on the receiving side: the game page is untrusted.
import type { SnapMessage } from "@tcg/shared";

// host -> game
export type HostMessage =
  | { t: "snap"; snap: SnapMessage }
  | { t: "status"; text: string; me: string | null; draining: boolean; spectator?: boolean }
  | { t: "key"; key: string; down: boolean };

// game -> host
export type GameMessage =
  | { t: "ready" }
  | { t: "input"; dx: number; dy: number; action: boolean; seq: number }
  // The player pressed V: switch between playing and spectating (the host reconnects).
  | { t: "mode"; spectate: boolean };

const unit = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : null);

// Host side: accept only the message shapes the game may send, with sane values.
export function parseGameMessage(d: unknown): GameMessage | null {
  if (!d || typeof d !== "object") return null;
  const m = d as Record<string, unknown>;
  if (m.t === "ready") return { t: "ready" };
  if (m.t === "mode") return { t: "mode", spectate: m.spectate === true };
  if (m.t !== "input") return null;
  const dx = unit(m.dx), dy = unit(m.dy);
  const seq = m.seq;
  if (dx === null || dy === null || typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > 2 ** 31) return null;
  return { t: "input", dx, dy, action: m.action === true, seq };
}

// Game side: the host is trusted, but only its own window may talk to us.
export function parseHostMessage(d: unknown): HostMessage | null {
  if (!d || typeof d !== "object") return null;
  const m = d as Record<string, unknown>;
  if (m.t === "snap" && m.snap && typeof m.snap === "object") return m as unknown as HostMessage;
  if (m.t === "status" && typeof m.text === "string") return { t: "status", text: m.text, me: typeof m.me === "string" ? m.me : null, draining: m.draining === true, spectator: m.spectator === true };
  if (m.t === "key" && typeof m.key === "string") return { t: "key", key: m.key, down: m.down === true };
  return null;
}

// Token bucket matching the server's 10 msg/s limit (ratelimit.ts), with headroom, so the host
// never makes the server drop an input. Dropped sends are retried by the game's InputSender.
export class SendBudget {
  private tokens: number;
  private last: number;
  constructor(private rate = 8, private burst = 8, now = 0) { this.tokens = burst; this.last = now; }
  take(now: number): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
