// Shared helpers for scenario authors. Pure functions only.
export const clamp1 = (v) => Math.max(-1, Math.min(1, v));

/** Input steering from (x, y) toward (tx, ty); zero on an axis within `dead` px. */
export function steer(x, y, tx, ty, dead = 2) {
  const dx = tx - x;
  const dy = ty - y;
  return { dx: Math.abs(dx) > dead ? clamp1(dx / 20) : 0, dy: Math.abs(dy) > dead ? clamp1(dy / 20) : 0, action: false };
}
