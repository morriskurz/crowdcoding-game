// Agent-editable. Numbers only. No imports outside @tcg/shared.
// Units: px and ticks (15 ticks = 1 s). The player is 20 px wide (playerR 10).
export const config = {
  tickHz: 15,
  drainSeconds: 60, // per-game drain window, Q19

  // Tower. y grows downward; the ground surface is at floorY.
  towerWidth: 600,
  towerHeight: 3100,
  floorY: 3000,
  groundH: 40,
  topH: 20,
  topW: 160,
  sectionCount: 12,
  stepsPerSection: 5, // two step types alternate in each section
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
  blinkPeriod: 45, // blinking platforms: on for blinkOn ticks of every blinkPeriod
  blinkOn: 27,
  warnTicks: 8, // a blinking platform flickers this long before it vanishes
  crumbleFuse: 8, // a crumbling platform drops this many ticks after someone lands on it
  crumbleDown: 45, // ... and is back after this many
  spinnerLen: 50, // spinning lava bar: half length (it turns around its middle, above a ledge)
  spinnerLift: 50, // pivot height above the ledge surface
  spinnerSpeed: 0.21, // radians per tick (half a turn in 1 s)

  // Run: fast ground acceleration, less in the air (responsive, but a jump is a commitment).
  runSpeed: 8,
  groundAccel: 4,
  groundDecel: 5,
  iceAccel: 0.8, // on ice: slow to start, slower to stop
  iceDecel: 0.4,
  stickDeadZone: 0.3, // past this the stick counts as full speed in its direction
  airAccel: 2,
  airDecel: 0.6,

  // Jump: fast rise, short hang at the apex while held, faster fall; letting go cuts the jump short.
  jumpSpeed: 28,
  gravityRise: 5.6,
  gravityFall: 9,
  apexSpeed: 5, // |vy| below this counts as the apex
  apexGravityMult: 0.6, // gravity at the apex while jump is held
  jumpCutSpeed: 8, // releasing jump while rising faster than this caps the rise to it
  maxFall: 30,
  coyoteTicks: 2, // can still jump this many ticks after walking off a ledge
  jumpBufferTicks: 2, // a jump pressed this many ticks before landing still fires

  playerR: 10,
  bumpPush: 4,

  roundSeconds: 180,
  resultsSeconds: 5,
  fallShownPx: 200, // a drop of at least this much counts as a fall (sound, spectator cut)
} as const;
