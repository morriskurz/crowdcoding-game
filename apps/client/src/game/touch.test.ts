import { describe, expect, it } from "vitest";
import { TouchPad, mergeInput } from "./touch.js";

const W = 400, H = 800;
const { action, toggle } = TouchPad.layout(W, H);

describe("TouchPad", () => {
  it("starts hidden on non-touch devices and shows after the first touch", () => {
    const t = new TouchPad(false);
    expect(t.enabled).toBe(false);
    t.down(1, 100, 600, W, H, false);
    expect(t.enabled).toBe(true);
  });

  it("joystick: analog, clamped to 1, snapped, with a dead zone", () => {
    const t = new TouchPad(true);
    expect(t.down(1, 100, 600, W, H, false)).toBe("stick");
    t.move(1, 105, 602); // inside the dead zone
    expect(t.read()).toEqual({ dx: 0, dy: 0, action: false });
    t.move(1, 400, 600); // far right: full speed
    expect(t.read()).toEqual({ dx: 1, dy: 0, action: false });
    t.move(1, 100 + 28, 600); // half way
    expect(t.read().dx).toBe(0.5);
    t.move(1, 0, 500); // up-left diagonal stays on the unit circle
    const i = t.read();
    expect(i.dx).toBeLessThan(0);
    expect(i.dy).toBeLessThan(0);
    expect(Math.hypot(i.dx, i.dy)).toBeLessThanOrEqual(1.1);
    t.up(1);
    expect(t.read()).toEqual({ dx: 0, dy: 0, action: false });
  });

  it("action button while steering with another finger", () => {
    const t = new TouchPad(true);
    t.down(1, 100, 600, W, H, false);
    t.move(1, 200, 600);
    expect(t.down(2, action.x, action.y, W, H, false)).toBe("action");
    expect(t.read()).toEqual({ dx: 1, dy: 0, action: true });
    t.up(2);
    expect(t.read().action).toBe(false);
    expect(t.read().dx).toBe(1);
  });

  it("toggle button works in both modes; spectating ignores stick and action", () => {
    const t = new TouchPad(true);
    expect(t.down(1, toggle.x + toggle.w / 2, toggle.y + toggle.h / 2, W, H, false)).toBe("toggle");
    expect(t.down(2, toggle.x + toggle.w / 2, toggle.y + toggle.h / 2, W, H, true)).toBe("toggle");
    expect(t.down(3, action.x, action.y, W, H, true)).toBe(null);
    expect(t.down(4, 100, 600, W, H, true)).toBe(null);
    expect(t.read()).toEqual({ dx: 0, dy: 0, action: false });
  });

  it("clear drops every finger (window blur)", () => {
    const t = new TouchPad(true);
    t.down(1, 100, 600, W, H, false);
    t.move(1, 300, 600);
    t.down(2, action.x, action.y, W, H, false);
    t.clear();
    expect(t.read()).toEqual({ dx: 0, dy: 0, action: false });
  });
});

describe("mergeInput", () => {
  it("stick wins when pushed, keys otherwise, action from either", () => {
    expect(mergeInput({ dx: 1, dy: 0, action: false }, { dx: 0, dy: 0, action: true })).toEqual({ dx: 1, dy: 0, action: true });
    expect(mergeInput({ dx: 1, dy: 1, action: true }, { dx: -0.5, dy: 0, action: false })).toEqual({ dx: -0.5, dy: 0, action: true });
  });
});
