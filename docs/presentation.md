# Presentation + content gates

Every agent PR (head branch `f/*`) gets a 2-minute before/after presentation that viewers watch
before the ship vote. CI makes it from the real branch (`.github/workflows/present.yml`). Agents
never supply media. The same recordings feed the content gates, because agent-written code runs
on stream.

## What runs

1. Two checkouts: `before` = the PR's base commit on main, `after` = the PR head.
2. Each client is built and served by `scripts/present/server.mjs`, an in-process sim server. It
   runs the checkout's real `@tcg/shared` sim and game rules on the same `/parties/<party>/<room>`
   WebSocket path as the Worker. It replaces `wrangler dev` because the Durable Object seeds its
   world randomly. Both sides use seed 1337 and the same bot scenario.
3. `scripts/present/record.mjs` plays each side in headless Chrome (playwright-core) for 20 s.
   The sim holds at ticks 60/150/270 for the 3 screenshots, so before and after show the same tick.
   Video comes from CDP screencast frames, encoded with system ffmpeg to H.264 at 25 fps. Audio
   comes from a WebAudio tap (`instrument.js`) and is muxed into the mp4 as AAC.
4. The gates run on the after-run:

| gate | rule | script |
|---|---|---|
| `flash` | per-frame mean luma (signalstats YAVG). Fails if more than 3 frame-to-frame jumps of more than 20/255 fall in any 1 s window | `scripts/gates/flash.mjs` |
| `audio` | sample peak of the captured WebAudio output. Fails above -1 dBFS | `scripts/gates/audio.mjs` |
| `ocr` | tesseract on the 3 screenshots (2x upscaled, normal and inverted). Fails on any word in the hashed slur list | `scripts/gates/ocr.mjs` |
| `frameTime` | p95 cost of the client's snapshot handler, including a canvas readback, compared with main's stored baseline for the same scenario. Fails if more than 20 % slower on both raw ms and calibration-normalized ms. `no-baseline` if there is no baseline | `scripts/gates/frametime.mjs` |

5. Artifact `presentation`, uploaded even when a gate fails:
   - `index.json`
   - `report.json` (gate details, timings, same-run before/after frame times)
   - `before/` and `after/` (`video.mp4`, `shot-1..3.png`, `audio.wav`, `frames.json`)

   The job fails if any gate fails.

`index.json`:

```json
{ "pr": 12, "featureId": "101", "headSha": "…", "scenario": "collect",
  "before": { "video": "before/video.mp4", "screenshots": ["before/shot-1.png", "…"] },
  "after":  { "video": "after/video.mp4",  "screenshots": ["after/shot-1.png", "…"] },
  "captions": ["…"],
  "gates": { "flash": "pass", "audio": "pass", "ocr": "pass", "frameTime": "no-baseline" } }
```

## Agent inputs (at the PR head, all untrusted)

- `feature.json`: `{id, spec, slug, game?, branch, status, scenario?}`. `featureId` comes from `id`.
  `scenario` must name one of `scripts/scenarios` (`idle-crowd` (default), `chase`, `collect`, `play`, `showcase`).
  Any other value falls back to the default. Without a valid `scenario`, a game that stages its newest
  feature (`rules.showcase`) records `showcase`: bot 0 is the hero, the game moves it and sets up the moment
  (about 3 times in 10 s), the client's spectator camera follows the hero (`data.showcase`), and the other
  bots play. A before-side checkout without the hook records the same scenario with the hero playing
  normally. Otherwise the scenario is inferred from `spec`,
  and a game with its own bot (`rules.bot`) plays itself instead (`play`: every bot runs the game's
  bot AI), because the steering-only scenarios never press action (no jumping, climbing or racing).
  `index.json` records the scenario that actually ran.
- The recorder watches as a spectator (`?spectate=1`), like the stream overlay: the camera follows the
  action (the game's `spectateTarget`, else the director), so a world larger than the view (a tall
  tower) is filmed where the players are, not at its top-left corner.
  `game` (written by `orchestrate.mjs start`) is the game directory both sides present, loaded through
  the game registry (`@tcg/games`). A side whose checkout has no such game (the before side of a weekly
  bootstrap) presents that checkout's current game; an invalid value is ignored. `index.json` records
  `game: {before, after}`.
- `captions.json` (optional): array of strings. Non-strings and captions containing a listed word
  are dropped. Control and bidi characters are stripped. Each caption is capped at 140 chars, and
  at most 20 are kept.

## Trust

- No secrets, and the token is read-only (`contents: read`, plus `actions: read` to download the
  baseline artifact). Installs skip lifecycle scripts, so `server.mjs` generates each checkout's game
  registry itself (`scripts/registry.mjs` from the main checkout).
- The pipeline code always comes from the main checkout. From the PR head, only the game, the
  client, `feature.json` and `captions.json` are used.
- `scripts/present/`, `scripts/gates/` and `scripts/scenarios/` are frozen in `scripts/guard.mjs`.
  A PR cannot weaken the gates that judge it, and cannot weaken them on main through a ship vote.
- The slur list is stored only as sha256 hashes (`scripts/gates/slur-hashes.json`). To add a word
  locally: `node scripts/gates/wordlist.mjs add <word>`.

## Frame-time baseline

`.github/workflows/present-baseline.yml` runs on every push to main. It records all scenarios and
uploads `frametime-baseline.json` as artifact `frametime-baseline`. `present.yml` downloads it from
the latest successful run on main.

Headless SwiftShader numbers are relative, not absolute. They repeat within a few percent on one
machine. A fixed Canvas2D calibration workload, run in the same browser, normalizes for runner
speed. A regression has to show in both the raw and the normalized ratio, which keeps runner speed
and calibration noise from failing PRs on their own.

## Run locally

Needs Chrome or Chromium, ffmpeg and tesseract, and both checkouts `pnpm install`ed.

```bash
node --test scripts/present/present.test.mjs
node scripts/present/baseline.mjs --root <main checkout> --out baseline          # optional
node scripts/present/run.mjs --before <main checkout> --after <PR checkout> \
  --out presentation [--baseline baseline/frametime-baseline.json] [--pr 12]
```

Single steps: `record.mjs --root <checkout> --out <dir> --scenario chase`, and
`node scripts/gates/<gate>.mjs <file>…`. Each prints JSON and exits 1 on fail.
`CHROME_PATH` overrides Chrome discovery.

## Render gate

- `render`: fails when the after-run shows no motion (mean ffmpeg signalstats YDIF < 0.05) or all screenshots are identical. Guards against blank or frozen recordings, which would otherwise pass every content gate.
