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
  collisionShakeIntensity: 5,
  collisionShakeDuration: 0.2,
  blowbackStrength: 0.15,
  blowbackMax: 12,
  botCount: 4,
  botSpeed: 2,
  spikedChance: 0.2,
  sweetChance: 0.2,
  spikedGrowth: 0.3,
  sweetGrowth: 2,
  specialistBonus: 0.5,
  specialistMin: 3,
} as const;
