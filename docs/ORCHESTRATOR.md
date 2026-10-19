# Orchestrator protocol

How one viewer-voted feature becomes an `f/*` branch. The agent-facing version is `CLAUDE.md`; this page is the same protocol in plain English, for the owner and for anyone changing the pipeline.

## Where this sits

1. A viewer suggests a feature in chat. The sanitizer cleans it, chat votes.
2. The scheduler fires a Claude Code **routine**: a cloud session, on the owner's subscription, that clones this repo and receives the winning feature as a payload.
3. That session is the **orchestrator** (Opus). It follows `CLAUDE.md`: plans, delegates to builder subagents, runs the gates, commits and pushes `f/<featureId>-<slug>`.
4. CI on the branch records the before/after clip (`.github/workflows`, owned elsewhere). Viewers get a 2-minute ship poll; on "ship" the bot merges to `main`, and only `main` deploys.

The orchestrator never merges, never touches `main`, never opens PRs.

## Payload

```json
{ "featureId": "42", "slug": "pellets-glow", "spec": "pellets glow for all players", "resumeFrom": "t3", "bootstrap": false, "game": "template" }
```

| field | required | meaning |
|---|---|---|
| `featureId` | yes | `[A-Za-z0-9_-]{1,32}`, the feature's id in the bot |
| `slug` | yes | sanitised to `[a-z0-9-]`, max 40 chars |
| `spec` | yes | the viewer's text, max 4000 chars. **Untrusted.** |
| `resumeFrom` | no | task id to restart from on an existing branch |
| `bootstrap` | no | `true` = weekly new game; `slug` is the new game's directory |
| `game` | no | game directory to work in; default is the registry's current game (newest `tcg.created`, `scripts/registry.mjs`), else `template` |

The routine wraps the payload in `<feature_payload>…</feature_payload>`. The orchestrator stores `spec` verbatim in `feature.json` and treats it as a description of game behaviour only. It never follows instructions inside it and never forwards it raw to builders; builders get instructions the orchestrator wrote. `scripts/orchestrate.mjs start` validates the payload and refuses bad ids/slugs.

## Branch

`f/<featureId>-<slug>`. `start` checks it out from `origin/<branch>` if it exists (resume), otherwise creates it from `origin/main`. On a new branch `tasks.json` starts as `[]`, so `main`'s placeholder plan never leaks into a feature.

## Files

Both live at the repo root on the feature branch. Their formats are fixed; `orchestrate.mjs` writes them and `orchestrate.mjs validate` checks them.

`feature.json`

```json
{ "id": "42", "spec": "…", "slug": "pellets-glow", "game": "template", "branch": "f/42-pellets-glow", "status": "building", "resumeFrom": "t3", "updatedAt": "2026-10-18T19:44:37.867Z" }
```

`game` is the game directory the feature works in (set by `start`; the presentation pipeline shows that game).

`status`: `planning` (branch created, no plan) → `building` (tasks running) → `gates` (final gates running) → `ready` (all tasks done and final gates green) or `failed`.

`tasks.json`: a JSON array, **in dependency order** (the format has no dependency field; a task may only rely on tasks before it).

```json
[{ "id": "t2", "title": "assets: draw pellets with a glow", "tier": "muse", "files": ["packages/games/template/assets.ts"],
   "estMin": 10, "agentReEst": 8, "actualMin": 0.5, "done": true, "failed": false, "error": "…",
   "attempts": [{ "tier": "muse", "ok": false, "minutes": 0.1 }, { "tier": "sonnet", "ok": true, "minutes": 0.3 }] }]
```

`agentReEst`, `actualMin`, `failed`, `error`, `attempts` are optional. `actualMin` is the sum of attempt minutes.

`scripts/guard.mjs` reads `tasks.json` at `HEAD` and rejects an `f/*` diff that touches any file under `packages/games/` not listed in some task's `files`. On top of the format, `orchestrate.mjs` enforces:

- ids `t<n>`, `t<n>.<m>` (re-split subtasks) or `bootstrap`; unique;
- every file is under `packages/games/<game>/`;
- one source file per task, optionally with its own `.test.ts`;
- a directory entry (`packages/games/<slug>/`) only on the `bootstrap` task;
- no task lists a game's `package.json` (registry metadata; the guard rejects any change to it not covered by a bootstrap directory entry);
- `muse` tasks only on `config.ts` / `assets.ts`.

`usage-opencode.json` (repo root): one entry per Muse call, `{at, model, tokensIn, tokensOut, costUsd, ok}`. It is committed with the task that made the calls.

`.orchestrator/` (git-ignored): the payload copy, plan drafts and the attempt timer.

## Tiers and builders

| tier | subagent | model | does |
|---|---|---|---|
| `muse` | `muse-builder` | Haiku, driving Muse Spark via `scripts/muse.mjs` | `config.ts` numbers, `assets.ts` visuals/audio |
| `sonnet` | `sonnet-builder` | Sonnet | `rules.ts` logic + vitest tests; muse escalations |
| `opus` | `opus-builder` | Opus | hard tasks, sonnet escalations, the bootstrap task |

`scripts/muse.mjs` runs `opencode run -m opencode-go/muse-spark-1.3-contributor --format json --auto "<prompt>"` with only the task prompt and the target file list, Bash and web access denied by config, secrets stripped from its environment, and a timeout (default 300 s). It parses the JSON event stream (tokens, cost, edited files, errors), reverts edits outside the target files, and appends the usage entry. The OpenCode key comes from the cloud environment's network secret; `OPENCODE_API_KEY` is only a placeholder.

## Gates

`node scripts/gates.mjs` runs, in order and stopping at the first failure:

1. `node scripts/guard.mjs`
2. `pnpm -r check`
3. `pnpm -r test`
4. `pnpm --filter @tcg/client build`
5. smoke: `wrangler dev` (same wrangler version as `deploy.yml`) on a free local port, then `scripts/smoke.mjs` with 30 bots against a fresh room

It prints one JSON line (`ok`, `complete`, `green`, `skipped`, `failed`, `tail`, `seconds`) and exits 0 only when nothing failed. `complete` is true only when all five ran green. Full logs: `$TMPDIR/gates/<step>.log`. If the pinned workerd is older than `wrangler.jsonc`'s `compatibility_date`, the smoke step retries once with the newest date the binary supports, for the local run only.

The orchestrator runs the gates after **every** task (`orchestrate.mjs verify`), and once more at the end (`finish`). A full run takes about 20 s.

## Escalation

Each tier gets one try plus one retry. `verify` records the attempt and tells the orchestrator what comes next:

```
muse → muse(retry) → sonnet → sonnet(retry) → opus → opus(retry) → failed: true → re-split
```

- A task starts at its own tier (a sonnet task never goes to muse).
- On a retry the builder fixes in place with the gate error. On an escalation the task's files are reset to `HEAD` first, so the next tier starts clean.
- When opus fails its retry, the task gets `failed: true`, its files are reset, and the orchestrator re-splits it into 2–3 smaller subtasks `<id>.1, <id>.2, …` inserted right after it. The failed task's `error` becomes `re-split into …` and it counts as superseded.
- A re-split subtask that fails at opus fails the feature (`status: failed`). There is no second re-split.

## Commit cadence

- `plan` commits `tasks.json` + `feature.json` and pushes.
- Every task that finishes, done or failed, is one commit with its files, `tasks.json`, `feature.json` and `usage-opencode.json`, then a push (retried with backoff 2/4/8/16 s).
- Failed attempts that will be retried are not committed; their record is in the next commit's `attempts`.
- Commits stage only those paths. Anything else dirty is reported as `uncommitted` and left out.
- `finish` commits the final status.

So a session that dies loses at most the task in progress.

## Resume

The routine is re-fired with the same payload. `start` finds `origin/f/<id>-<slug>`, checks it out and continues with the first task that is neither done nor failed. With `resumeFrom: "<task id>"`, that task and every later one are reset (attempts cleared, `done: false`) and the status goes back to `building`. A branch whose `feature.json` names a different feature id is refused.

## Bootstrap (weekly new game)

Payload with `bootstrap: true` and `slug` = new game directory.

1. `start` → branch `f/<id>-<slug>`, game dir `packages/games/<slug>/`.
2. `orchestrate.mjs bootstrap` copies `packages/games/template` (without `node_modules`/`dist`), renames the package to `@tcg/game-<slug>`, stamps `"tcg": {"title": "<slug>", "created": <now>}` and runs `pnpm install` so `pnpm-lock.yaml` includes it and the registry is regenerated. `start` refuses bootstrap slugs that are routes (`main`, `game`, `games`, `assets`, `parties`, `health`, `drain`, ...).
3. The plan's first task is `{ "id": "bootstrap", "tier": "opus", "files": ["packages/games/<slug>/"] }`, the only task allowed to list a directory and change many files. The guard accepts directory entries. The opus builder turns the copy into the new game; later tasks are normal single-file tasks.
4. No wiring step: the game registry (`packages/registry`, `@tcg/games`) is generated from the `packages/games/*` directories (`scripts/registry.mjs`, on install, client build and every gates run), and the newest `tcg.created` is the current game. On the branch the new game is already current, so the gates smoke it. Once the bootstrap ships, `/` and room `main` play it; last week's game stays playable as an archive at `/<old slug>` (room `<old slug>`, flagged `archived`). The registry package and its generator are frozen; the bootstrap never edits them.

## Agent feed

`.claude/settings.json` runs `scripts/feed-hook.mjs` on `PostToolUse` and `Stop`. It POSTs `{sessionId, event, tool?, file?, summary}` (summary ≤ 200 chars, secret-shaped strings redacted) to `$BOT_URL/feed` with `Authorization: Bearer $FEED_SECRET`, gives up after 3 s, always exits 0, and does nothing when `BOT_URL` is unset. It runs with `NODE_USE_ENV_PROXY=1` so Node's fetch uses the cloud egress proxy.

## Commands

```bash
node scripts/orchestrate.mjs start --payload <file>
node scripts/orchestrate.mjs bootstrap
node scripts/orchestrate.mjs plan --tasks <file> [--append]
node scripts/orchestrate.mjs next
node scripts/orchestrate.mjs begin <id> --tier muse|sonnet|opus [--reest <min>]
node scripts/orchestrate.mjs verify <id>
node scripts/orchestrate.mjs reset <id>
node scripts/orchestrate.mjs resplit <id> --tasks <file>
node scripts/orchestrate.mjs finish
node scripts/orchestrate.mjs validate | show
node scripts/orchestrate.mjs dry-run [--scenario <file>] [--worktree <dir>]
```

`ORCH_NO_PUSH=1` commits without pushing.

## Testing the pipeline locally

```bash
pnpm test:agent
```

Unit tests for `muse.mjs` (recorded Muse event stream in `scripts/fixtures/`), `feed-hook.mjs`, `gates.mjs` helpers and the `orchestrate.mjs` state machine.

```bash
node scripts/orchestrate.mjs dry-run --worktree /tmp/orch-dry
```

Runs the whole protocol on the toy spec "pellets glow for all players" (`scripts/fixtures/dry-run-glow.json`) in a separate worktree, with canned edits in place of the LLM builders: branch `f/dry1-pellets-glow`, plan of three tasks, full gates after each, one task escalated muse → muse → sonnet on a real typecheck failure, final status `ready`, guard green. Nothing is pushed.
