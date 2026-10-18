import { describe, it, expect } from "vitest";
import { SendBudget, parseGameMessage, parseHostMessage } from "../bridge.js";
import { InputSender, readKeys } from "./input.js";

describe("bridge validation", () => {
  it("host accepts only well-formed game messages, clamped", () => {
    expect(parseGameMessage({ t: "ready" })).toEqual({ t: "ready" });
    expect(parseGameMessage({ t: "input", dx: 5, dy: -0.5, action: true, seq: 3 })).toEqual({ t: "input", dx: 1, dy: -0.5, action: true, seq: 3 });
    expect(parseGameMessage({ t: "input", dx: NaN, dy: 0, seq: 1 })).toBeNull();
    expect(parseGameMessage({ t: "input", dx: 0, dy: 0, seq: 1.5 })).toBeNull();
    expect(parseGameMessage({ t: "input", dx: 0, dy: 0, seq: -1 })).toBeNull();
    expect(parseGameMessage({ t: "navigate", url: "https://evil" })).toBeNull();
    expect(parseGameMessage("input")).toBeNull();
    // extra fields never pass through
    expect(parseGameMessage({ t: "input", dx: 0, dy: 0, seq: 1, action: "yes", code: "x" })).toEqual({ t: "input", dx: 0, dy: 0, action: false, seq: 1 });
  });

  it("game accepts host messages", () => {
    expect(parseHostMessage({ t: "status", text: "live", me: "abc" })).toEqual({ t: "status", text: "live", me: "abc", draining: false });
    expect(parseHostMessage({ t: "key", key: "w", down: true })).toEqual({ t: "key", key: "w", down: true });
    expect(parseHostMessage({ t: "x" })).toBeNull();
  });

  it("send budget stays under the server rate limit", () => {
    const b = new SendBudget(8, 8, 0);
    let sent = 0;
    for (let t = 0; t < 10_000; t += 10) if (b.take(t)) sent++;
    expect(sent).toBeLessThanOrEqual(8 + 8 * 10);
  });
});

describe("InputSender", () => {
  it("sends on change with increasing seq, throttled, resends until acked", () => {
    const s = new InputSender(100, 300);
    const still = { dx: 0, dy: 0, action: false }, right = { dx: 1, dy: 0, action: false };
    expect(s.tick(still, 0, 0)).toEqual({ ...still, seq: 1 });
    expect(s.tick(still, 66, 0)).toBeNull();
    expect(s.tick(right, 90, 0)).toBeNull(); // changed, but inside the 100 ms gap
    expect(s.tick(right, 133, 0)).toEqual({ ...right, seq: 2 });
    expect(s.tick(right, 200, 2)).toBeNull(); // acked: quiet
    expect(s.tick(still, 266, 2)).toEqual({ ...still, seq: 3 });
    expect(s.tick(still, 400, 2)).toBeNull();
    expect(s.tick(still, 566, 2)).toEqual({ ...still, seq: 3 }); // lost? resend same seq
  });

  it("maps WASD/arrows/space", () => {
    expect(readKeys(new Set(["w", "arrowright", " "]))).toEqual({ dx: 1, dy: -1, action: true });
  });
});
