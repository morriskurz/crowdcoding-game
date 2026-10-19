# @tcg/kit

Frozen Canvas2D + WebAudio helpers for this week's game. Import from `packages/games/<slug>/assets.ts`:

```ts
import { Trail, drawGlow, ease, tween, type Fx, type GameAssets } from "@tcg/kit";
```

No runtime dependencies, no DOM access at import time, no audio/image files. Agents never edit this package (guard: frozen on `f/*` branches).

## The assets.ts contract

The client renderer imports `assets` (a `GameAssets`) and `rules` from the game package and calls:

| Export | When | Space |
|---|---|---|
| `scene: Scene` | once: `{ width, height, background?, zoom? }`, the camera clamps to it | |
| `drawBackground(ctx, fx)` | every frame, before entities | world |
| `drawEntity(ctx, e, fx)` (required) | every frame, per visible entity (others interpolated, you predicted) | world |
| `drawOverlay(ctx, fx)` | every frame, after particles | screen |
| `onSnapshot(prev, next, fx)` | once per server snapshot (15 Hz): diff to fire particles/sfx/shake | |

Player names are drawn by the renderer, never by game code.

`fx: Fx` = `{ camera, particles, sfx, time, dt, me }`. `me` is your player id (entity id === player id).

## API

### Camera
`new Camera()`, fields `x, y` (world point at screen center), `zoom`, `stiffness` (follow smoothing, 0 = snap), `bounds`.
- `follow(x, y, snap?)`, `update(dt)`, `shake(intensity px, duration s)`
- `apply(ctx)` / `reset(ctx)`: wrap world drawing
- `worldToScreen(x, y)`, `screenToWorld(x, y)`, `visible(x, y, r)`

### Interpolation
- `new SnapshotBuffer<S>({ hz = 15, delay = 2, size = 16 })`: `push(tick, state, nowMs)`, `sample(nowMs) → { a, b, t, tick } | null`, `serverTick(nowMs)`
- `lerpBodies(a, b, t, maxJump = 200)`: blend id-keyed `{ id, x, y, r? }` maps; teleports snap
- `new FixedStep(stepMs, maxSteps)`: `advance(ms) → steps`, `alpha`

### Particles (pooled)
`new Particles(capacity = 512)`: fixed struct-of-arrays pool, a full pool recycles live particles instead of growing.
- `emit({ x, y, count, color, speed, speedJitter, angle, spread, vx, vy, life, lifeJitter, size, gravity, drag, additive = true, shrink = true })`
- `update(dt)`, `draw(ctx)` (additive particles use glow sprites + `"lighter"`), `clear()`, `count`

### Trail
`new Trail(maxPoints = 16, minDist = 2)`: `push(x, y)`, `draw(ctx, { color, width, alpha, additive })`, `shrink()`, `clear()`

### Glow
- `drawGlow(ctx, x, y, radius, color, alpha = 1, falloff = 0.5)`: additive halo from a cached pre-rendered sprite
- `glowSprite(color, radius, falloff)`, `makeSprite(w, h, draw)`, `makeCanvas(w, h)`: pre-render once, `drawImage` every frame
- `additive(ctx, fn)`: run `fn` with `"lighter"` blending

### Tween / math
`clamp, lerp, unlerp, damp(current, target, rate, dt), lerpAngle, pulse(time, period)`, `ease.{linear, inQuad, outQuad, inOutQuad, outCubic, inOutCubic, outBack, outElastic, outBounce}`, `tween(from, to, elapsed, duration, ease)`, `new Tween(from, to, duration, ease)` with `update(dt)`, `value`, `done`, `restart()`.

### Sfx (WebAudio synth bank)
`fx.sfx.play(name, { volume, pitch, pan })` with `name` one of
`blip click coin pickup powerup jump laser hit hurt explode die win lose whoosh step` (`SOUND_NAMES`).
The bank is fixed: games choose sounds, they do not ship synth code. Repeats of one sound within 30 ms collapse into one, at most 24 voices play at once. `volume`, `muted`, `unlock()` (the renderer calls it on the first key/pointer press).
