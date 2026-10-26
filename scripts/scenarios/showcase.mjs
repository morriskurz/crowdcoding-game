import collect from "./collect.mjs";
import idleCrowd from "./idle-crowd.mjs";

// The game stages its newest feature (rules.showcase): bot 0 is the hero, the game moves it and sets up
// the moment (spawns the new thing in its path, triggers the event), and the spectator camera follows it.
// The others play with the game's bot AI, else collect pellets. Without rules.showcase the hero plays too,
// so a before-side checkout from before the feature still records a normal game.
export default {
  bots: 8,
  description: "the game stages its newest feature around bot 0 (the hero, followed by the camera); the rest play",
  input(tick, i, view) {
    if (i === 0) {
      const staged = view.showcase(0);
      if (staged) return staged;
    }
    return view.gameBot(i) ?? collect.input(tick, i, view) ?? idleCrowd.input(tick, i);
  },
};
