import idleCrowd from "./idle-crowd.mjs";

// The game plays itself: every bot uses the game's own bot AI (rules.bot, the one the live server
// runs for idle bots), so a platformer climbs, a racer races. Without a game bot: the idle crowd.
// The sim server picks this for a game with its own bot unless feature.json names a scenario, since
// the blob-era scenarios only steer and never use the action button.
export default {
  bots: 12,
  description: "12 bots play the game with its own bot AI (idle crowd if the game has none)",
  input(tick, i, view) {
    return view.gameBot(i) ?? idleCrowd.input(tick, i);
  },
};
