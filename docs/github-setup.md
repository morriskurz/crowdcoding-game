# GitHub setup for the deploy boundary (spec §8, B2e)

The workflows only protect the Cloudflare token once these repository settings exist.
Run the steps once, as the repository owner. `OWNER/REPO` is `morriskurz/crowdcoding-game`. The repository is public: branch protection, Environments and auto-merge are available on the free plan only for public repositories.

## What the workflows assume

- `.github/workflows/ci.yml` runs on every push and pull request, has **no secrets**, and contains two jobs:
  - `guard-test-build` runs guard, typecheck, tests and the client build.
  - `no-github-changes` fails when a non-main branch changes `.github/**`.
- `.github/workflows/deploy.yml` runs on push to `main` and on manual `workflow_dispatch` (input `ref` = commit to redeploy, used for rollback).
  - Its `deploy-live` job uses the Environment `live`, which holds the token.
  - The token is visible only to the `wrangler deploy` step. That job installs dependencies with `--ignore-scripts`.
- The default branch is `main`.

## 1. Create Environment `live`, restricted to `main`

```bash
gh api -X PUT repos/OWNER/REPO/environments/live -F "deployment_branch_policy[protected_branches]=false" -F "deployment_branch_policy[custom_branch_policies]=true"
```

```bash
gh api -X POST repos/OWNER/REPO/environments/live/deployment-branch-policies -f name=main -f type=branch
```

## 2. Put the token in the Environment, not in repository secrets

```bash
gh secret set CLOUDFLARE_API_TOKEN --env live --repo OWNER/REPO
```

```bash
gh variable set CLOUDFLARE_ACCOUNT_ID --env live --repo OWNER/REPO --body "<cloudflare account id>"
```

```bash
gh variable set WORKER_WS --env live --repo OWNER/REPO --body "wss://<live worker host>"
```

Delete any old repository-level copies, so no branch workflow can read them:

```bash
gh secret delete CLOUDFLARE_API_TOKEN --repo OWNER/REPO
```

```bash
gh secret list --repo OWNER/REPO
```

The last list must not show `CLOUDFLARE_API_TOKEN`, `SMOKE_URL` or `WORKER_URL`. Delete any that remain.

## 3. Protect `main`

Save as `protection.json`:

```json
{
  "required_status_checks": { "strict": true, "contexts": ["guard-test-build", "no-github-changes"] },
  "enforce_admins": false,
  "required_pull_request_reviews": { "required_approving_review_count": 0, "require_code_owner_reviews": true },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
```

```bash
gh api -X PUT repos/OWNER/REPO/branches/main/protection --input protection.json
```

Effect:

- Nobody pushes `main` directly; changes arrive as pull requests with both checks green.
- `require_code_owner_reviews` plus `.github/CODEOWNERS` means a PR touching `.github/**` also needs the owner's review. This holds even if an agent deletes the `no-github-changes` job: a required check that never reports also blocks the merge.
- `enforce_admins: false` lets the owner change workflows (admin merge). The bot's merge token must **not** be an admin token.

Check whether `required_approving_review_count: 0` combined with code-owner review behaves as described on your plan `[needs verification]`.

## 4. Credentials that must stay apart

| Credential | Holder | Never held by |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Environment `live` only | agents, bot, repo secrets |
| Bot merge token (fine-grained PAT or GitHub App, `contents:write` + `pull_requests:write`, no admin) | ship-vote bot | agents |
| Agent push credential (can push `f/*` only) | cloud agent session | bot merge rights, Cloudflare |

## 5. Owner changes to workflows

`no-github-changes` fails on any branch that edits `.github/**`, including the owner's own branches. That is intended: merge such a PR as admin after reviewing it.

## Not covered here

- Automatic rollback when the post-deploy smoke fails. The spec gives that to the Cloudflare Cron watcher (§9). Until it exists, roll back by hand by redeploying the last good commit:

```bash
gh workflow run deploy.yml --repo OWNER/REPO -f ref=<last good sha>
```

- The `f/*` before/after recording workflow and the trusted `workflow_run` media publisher (§8).
