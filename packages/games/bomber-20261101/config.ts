// Agent-editable. Numbers only. No imports outside @tcg/shared.
// Units: px and ticks (15 ticks = 1 s). The arena is a grid of cols x rows cells of `cell` px.
export const config = {
  tickHz: 15,
  drainSeconds: 60, // per-game drain window, Q19

  // Grid arena. The outer ring is wall; pillars stand on every cell with even column and even row.
  cols: 15,
  rows: 13,
  cell: 40, // px; arena = 600 x 520
  brickChance: 0.55, // share of free interior cells that start as breakable bricks

  // Players
  playerR: 15,
  moveSpeed: 5, // px per tick (8 ticks per cell)
  stickDeadZone: 0.3,

  // Bombs
  fuseTicks: 45, // 3 s
  blastRange: 2, // cells per arm at round start
  maxBlastRange: 6, // pickups never push the range past this
  bombsPerPlayer: 1, // live bombs per player at a time
  blastTicks: 8, // how long a blast burns (and kills) after it goes off

  // Pickups dropped by broken bricks
  pickupChance: 0.12,

  // Knockouts
  respawnTicks: 45, // 3 s as a ghost before respawning
  protectTicks: 30, // 2 s of blinking protection after a (re)spawn

  // Crown
  crownTicks: 75, // ticks the leader's gold crown lasts (5 s)
  chainMultMinChain: 3, // bombs in a chain needed to earn the score multiplier
  chainMultTicks: 150, // multiplier lasts 10 s
  chainMultFactor: 1.5, // score factor on knockouts while active

  // Round loop
  roundSeconds: 180,
  resultsSeconds: 5,
} as const;
