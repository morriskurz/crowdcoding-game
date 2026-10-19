// Default. A crowd of players drifting in slow fixed patterns: shows the arena, players and
// pellets without much going on. Good for visual-only features.
export default {
  bots: 12,
  description: "12 bots drift in slow, fixed figure-of-eight patterns",
  input(tick, i) {
    const period = 90 + i * 7; // ticks, one per bot so they desync
    const ph = ((tick + i * 23) % period) / period;
    const a = ph * Math.PI * 2;
    return { dx: Math.round(Math.cos(a) * 2) / 2, dy: Math.round(Math.sin(2 * a) * 2) / 2, action: false };
  },
};
