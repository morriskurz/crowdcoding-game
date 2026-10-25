// Agent-editable. Numbers only. No imports outside @tcg/shared.
// Units: px and ticks (15 ticks = 1 s). The player is 20 px wide (playerR 10).
export const config = {
  tickHz: 15,
  drainSeconds: 60, // per-game drain window, Q19

  // Tower. y grows downward; the ground surface is at floorY.
  towerWidth: 600,
  towerHeight: 3700,
  floorY: 3600,
  groundH: 40,
  topH: 20,
  topW: 160,
  sectionCount: 12,
  stepsPerSection: 4,
  platformH: 12,
  ledgeW: 90,
  gapW: 56,
  beamW: 34,
  killW: 70,
  killH: 14,
  wallMargin: 40,
  movingPlatformSpeed: 2.5,
  movingRange: 90,
  reachSafety: 0.8, // generated jumps use at most this share of the longest possible jump

  // Run: fast ground acceleration, less in the air (responsive, but a jump is a commitment).
  runSpeed: 8,
  groundAccel: 4,
  groundDecel: 5,
  airAccel: 2,
  airDecel: 0.6,

  // Jump: fast rise, short hang at the apex while held, faster fall; letting go cuts the jump short.
  jumpSpeed: 22,
  gravityRise: 2.5,
  gravityFall: 4.2,
  apexSpeed: 4, // |vy| below this counts as the apex
  apexGravityMult: 0.6, // gravity at the apex while jump is held
  jumpCutSpeed: 6, // releasing jump while rising faster than this caps the rise to it
  maxFall: 26,
  coyoteTicks: 2, // can still jump this many ticks after walking off a ledge
  jumpBufferTicks: 2, // a jump pressed this many ticks before landing still fires

  playerR: 10,
  bumpPush: 4,

  blastOdds: 30, // a jump has a 1 in this many chance to explode
  blastRadius: 70, // px
  blastTicks: 8, // how long the explosion entity lives, in ticks
  blastKick: 14, // horizontal knock speed away from the centre
  blastSlam: 20, // downward vy given to players caught in it
  roundSeconds: 180,
  resultsSeconds: 5,
  fallShownPx: 200, // a drop of at least this much counts as a fall (sound, spectator cut)
} as const;
