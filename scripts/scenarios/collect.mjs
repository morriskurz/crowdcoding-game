import { steer } from "./helpers.mjs";

// Every bot heads for the nearest pellet (ties broken by entity order). Shows eating and growth.
export default {
  bots: 8,
  description: "8 bots greedily collect the nearest pellet",
  input(tick, i, view) {
    const me = view.bot(i);
    if (!me) return { dx: 0, dy: 0, action: false };
    let best = null;
    for (const e of view.entities) {
      if (e.kind !== "pellet") continue;
      const d2 = (e.x - me.x) ** 2 + (e.y - me.y) ** 2;
      if (!best || d2 < best.d2) best = { d2, x: e.x, y: e.y };
    }
    return best ? steer(me.x, me.y, best.x, best.y, 1) : { dx: 0, dy: 0, action: false };
  },
};
