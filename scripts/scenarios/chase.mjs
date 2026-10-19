import { steer } from "./helpers.mjs";

// Bot 0 runs a fixed loop around the arena, everyone else chases it (or the bot ahead of them).
// Shows movement, collisions and growth under pressure.
export default {
  bots: 10,
  description: "bot 0 laps the arena, the other 9 chase in a conga line",
  input(tick, i, view) {
    if (i === 0) {
      const side = Math.floor(tick / 60) % 4; // 4 s per side
      return [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 }][side];
    }
    const me = view.bot(i);
    const target = view.bot(i - 1);
    if (!me || !target) return { dx: 0, dy: 0, action: false };
    return steer(me.x, me.y, target.x, target.y, 4);
  },
};
