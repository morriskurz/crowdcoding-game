# crowdcoding-game

The game behind a 24/7 Twitch stream where chat votes on features and AI agents build them. A new multiplayer browser game every week, built on a small frozen core.

## Layout

| Path | What | Who changes it |
|---|---|---|
| `packages/shared` | Generic entity sim, deterministic physics, protocol, client prediction | frozen (owner) |
| `packages/kit` | Canvas2D/WebAudio helpers for `assets.ts`: camera, interpolation, particles, trails, glow, tweens, sfx bank ([API](packages/kit/README.md)) | frozen (owner) |
| `packages/games/<slug>` | One directory per game: `rules.ts`, `config.ts`, `assets.ts`. The newest (`package.json` `tcg.created`) is this week's game | agents, via `f/*` branches |
| `packages/registry` (`@tcg/games`), `scripts/registry.mjs` | Game registry: every `packages/games/*` keyed by slug + the current one, generated on install and client build (`games.gen.ts`, `apps/client/games/`, both git-ignored) | frozen (owner) |
| `apps/client` | Host page (WebSocket + postMessage bridge) and the game page in `<iframe sandbox="allow-scripts">`: predicts you, interpolates others | frozen (owner) |
| `apps/server` | Cloudflare Worker + Durable Object room, 15 Hz authoritative tick | frozen (owner) |
| `scripts/present`, `scripts/gates`, `scripts/scenarios` | Before/after presentation + content gates for agent PRs (`docs/presentation.md`) | frozen (owner) |
| `scripts/guard.mjs` | Lint gate: import allowlist, banned patterns, frozen files, plan-diff (agent branches) | frozen (owner) |
| `CLAUDE.md`, `.claude/`, `scripts/{orchestrate,gates,muse,feed-hook}.mjs` | Agent side: orchestrator instructions, builder subagents, gates, Muse wrapper, feed hooks. Protocol: `docs/ORCHESTRATOR.md` | owner |
| `.github/workflows` | `ci.yml` (no secrets, every branch), `present.yml` (no secrets, `f/*` PRs), `present-baseline.yml` (no secrets, `main`), `deploy.yml` (`main` only, Environment `live`) | owner only |

Agents only push `f/<id>-slug` branches. A change reaches `main` only after a viewer ship vote, and only `main` deploys.

## Games side by side

A new game every week; older games stay playable as archives.

| URL | Plays |
|---|---|
| `/`, `/game` | this week's game (host page, sandboxed game page) |
| `/<slug>`, `/<slug>/game` | that game; for an older game an "archived game" badge is shown |
| `/parties/<party>/main` (or any other room name) | this week's game; `/parties/<party>/<this week's slug>` is an alias of `main` |
| `/parties/<party>/<old slug>` | that game's archive room: playable, `archived: true` in `hello`, every `snap` and `/health?room=<old slug>` |

The weekly bootstrap only adds `packages/games/<slug>/` (stamped with `tcg.created`); once it ships, it is the current game. Nothing else is registered by hand. Slugs that are routes (`game`, `games`, `assets`, `parties`, `health`, `drain`, `main`, ...) are refused.

## Run locally

```bash
pnpm install   # postinstall generates the game registry (node scripts/registry.mjs)
```

```bash
node scripts/guard.mjs && pnpm -r check && pnpm -r test && pnpm --filter @tcg/client build
```

Sandbox + CSP check against a running Worker (`wrangler dev` serves `apps/client/dist` on :8787):

```bash
pnpm --filter @tcg/client build && npx wrangler dev &
node scripts/sandbox-check.mjs http://127.0.0.1:8787
```

Repository settings (Environment, secrets, branch protection): `docs/github-setup.md`.
