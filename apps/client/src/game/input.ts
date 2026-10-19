// Keyboard -> Input, and the send policy for prediction: inputs go out only when they change
// (server holds the last one), each with a new seq; unacknowledged inputs are resent.
import type { Input } from "@tcg/shared";

export function readKeys(keys: ReadonlySet<string>): Input {
  const has = (...k: string[]) => k.some((x) => keys.has(x));
  return {
    dx: (has("d", "arrowright") ? 1 : 0) - (has("a", "arrowleft") ? 1 : 0),
    dy: (has("s", "arrowdown") ? 1 : 0) - (has("w", "arrowup") ? 1 : 0),
    action: has(" ", "space", "enter"),
  };
}

const same = (a: Input, b: Input) => a.dx === b.dx && a.dy === b.dy && a.action === b.action;

export class InputSender {
  // seq of the current input. Starts at 1 so the first send marks where prediction begins
  // (the server's join-time zero input is seq 0).
  seq = 1;
  current: Input | null = null;
  private lastSend = -Infinity;
  private dirty = false;

  constructor(public minGapMs = 100, public resendMs = 300) {}

  // Call once per local tick. Returns the message to send now, if any. `acked` = seq the server applied.
  tick(input: Input, now: number, acked: number): (Input & { seq: number }) | null {
    if (!this.current) { this.current = { ...input }; this.dirty = true; }
    else if (!same(input, this.current)) { this.seq++; this.current = { ...input }; this.dirty = true; }
    const since = now - this.lastSend;
    const resend = !this.dirty && acked < this.seq && since >= this.resendMs;
    if ((this.dirty && since >= this.minGapMs) || resend) {
      this.dirty = false;
      this.lastSend = now;
      return { ...this.current, seq: this.seq };
    }
    return null;
  }
}
