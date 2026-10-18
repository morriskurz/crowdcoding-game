# crowdcoding-game

The game behind a 24/7 Twitch stream where chat votes on features and AI agents build them. A new multiplayer browser game every week, built on a small frozen core.

## Layout

| Path | What | Who changes it |
|---|---|---|
| `packages/shared` | Generic entity sim, deterministic physics, protocol | frozen (owner) |
| `packages/games/<slug>` | This week's game: `rules.ts`, `config.ts`, `assets.ts` | agents, via `f/*` branches |
| `apps/client` | Canvas2D client, renders server snapshots | frozen (owner) |
| `apps/server` | Cloudflare Worker + Durable Object room, 15 Hz authoritative tick | frozen (owner) |
| `scripts/guard.mjs` | Lint gate: import allowlist, banned patterns, frozen files, plan-diff (agent branches) | frozen (owner) |
| `CLAUDE.md`, `.claude/`, `scripts/{orchestrate,gates,muse,feed-hook}.mjs` | Agent side: orchestrator instructions, builder subagents, gates, Muse wrapper, feed hooks. Protocol: `docs/ORCHESTRATOR.md` | owner |
| `.github/workflows` | `ci.yml` (no secrets, every branch), `deploy.yml` (`main` only, Environment `live`) | owner only |

Agents only push `f/<id>-slug` branches. A change reaches `main` only after a viewer ship vote, and only `main` deploys.

## Run locally

```bash
pnpm install
```

```bash
node scripts/guard.mjs && pnpm -r check && pnpm -r test && pnpm --filter @tcg/client build
```

Repository settings (Environment, secrets, branch protection): `docs/github-setup.md`.
