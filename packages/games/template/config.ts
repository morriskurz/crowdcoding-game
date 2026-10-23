// Agent-editable. Numbers only. No imports outside @tcg/shared.
export const config = {
  speed: 3,
  bounds: 800,
  tickHz: 15,
  drainSeconds: 60, // per-game drain window, Q19
  pellets: 40,
  startSize: 8,
  pelletGlowRadius: 16,
  pelletGlowAlpha: 0.8,
  botCount: 4,
  botSpeed: 2,
} as const;
