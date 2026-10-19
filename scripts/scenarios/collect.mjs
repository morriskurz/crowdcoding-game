import { steer } from "./helpers.mjs";

// Bots fan out from the spawn point, then each greedily collects the nearest pellet.
// Shows eating and growth.
const BOTS = 8;
const SPREAD_TICKS = 45;

export default {
  bots: BOTS,
  description: "8 bots fan out for 3 s, then greedily collect the nearest pellet",
  input(tick, i, view) {
    if (tick < SPREAD_TICKS) {
      const a = (i / BOTS) * Math.PI * 2;
      return { dx: Math.round(Math.cos(a) * 2) / 2, dy: Math.round(Math.sin(a) * 2) / 2, action: false };
    }
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
