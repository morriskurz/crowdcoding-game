// Agent-editable. Numbers only. No imports outside @tcg/shared.
export const config = {
  speed: 3,
  bounds: 800,
  tickHz: 15,
  drainSeconds: 60, // per-game drain window, Q19
  pellets: 40,
  startSize: 8,
} as const;
