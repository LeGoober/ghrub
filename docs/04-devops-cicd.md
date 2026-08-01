# 04 — DevOps & CI/CD

## Branches (DevOps lifecycle)

```
feature/*  ──PR──►  dev  ──PR──►  staging  ──PR──►  main
  local work        CI only      Render pre-prod    Render production
```

- **`dev`** — integration. CI runs (lint, test, docker build). No deploy.
- **`staging`** — deploys to the Render *staging* service. Manual/PR promotion
  from `dev` once a milestone DoD is green.
- **`main`** — deploys to the Render *production* service. Promotion from
  `staging` only. Tag releases here (`v0.1.0`, `v0.2.0`).
- Never commit feature work straight to `staging`/`main`.

**Branch protection (set once, via GitHub UI or `gh`):** on `main` and
`staging` require PR + passing `ci` check; disallow direct pushes.

## GitHub Actions

Three workflows in `.github/workflows/` (scaffolded):

| Workflow | Trigger | Does |
|----------|---------|------|
| `ci.yml` | PR to any branch + push to `dev` | install → lint → test → seed smoke → `docker build` |
| `deploy-staging.yml` | push to `staging` | curl the Render **staging** deploy hook |
| `deploy-production.yml` | push to `main` | curl the Render **production** deploy hook |

CI never needs secrets. Deploy workflows need one secret each.

## Render deployment

Two ways to trigger Render; the scaffold uses **deploy hooks** (simplest, no key
in CI). Your Render **API key** stays for local/CLI use (e.g. `scripts/render-*`).

### Recommended: deploy hooks as GitHub secrets
1. In Render, create two Web Services from `render.yaml` (Blueprint): one for
   `staging`, one for `main` (or one service auto-deploying `main`, plus a
   staging service). Each service → Settings → **Deploy Hook** → copy URL.
2. In GitHub → repo → Settings → Secrets and variables → Actions, add:
   - `RENDER_DEPLOY_HOOK_STAGING`
   - `RENDER_DEPLOY_HOOK_PRODUCTION`
3. The deploy workflows `curl` the matching hook on push. Done.

### Alternative: Render API (uses your existing key)
If you'd rather drive deploys with the API key you already exported:
- Add GitHub secret `RENDER_API_KEY` and `RENDER_SERVICE_ID_*`.
- `scripts/render-deploy.sh` calls
  `POST https://api.render.com/v1/services/{id}/deploys`.
- Confirm the current Render API base/paths in Render's docs before relying on
  it — treat the endpoint above as needing verification, not gospel.

> Note: this sandboxed shell can't see your terminal's `RENDER_API_KEY` (it's a
> non-interactive session). That's fine — CI reads it from GitHub secrets, and
> local scripts read it from your own shell. Never commit the key.

## `render.yaml` (blueprint, scaffolded)

- One `web` service, Docker runtime, health check `/healthz`.
- A **disk** mounted at `/data` for `ghrub.db` (SQLite persistence).
- Env: `NODE_ENV=production`, `DATABASE_PATH=/data/ghrub.db`, `PORT` (Render
  provides), `ENABLE_LLM=false`.
- If you go free-tier Postgres instead: drop the disk block, set `DATABASE_URL`,
  and switch `repo.js` to the pg client (see `05-agent-runbook.md`).

## Environment variables

| Var | Where | Purpose |
|-----|-------|---------|
| `PORT` | Render-provided | server port |
| `DATABASE_PATH` | render.yaml | SQLite file path (`/data/ghrub.db`) |
| `NODE_ENV` | render.yaml | `production` |
| `ENABLE_LLM` | render.yaml | `false` in MVP; gates M5 LLM feature |
| `ANTHROPIC_API_KEY` | secret (only if `ENABLE_LLM=true`) | latest Claude model |
| `GHRUB_PASSPHRASE` | secret (optional) | simple shared-secret gate |
| `RENDER_DEPLOY_HOOK_*` | GitHub secret | CI → Render deploy |

## Local dev
```bash
npm install
npm run seed      # build + seed a local ghrub.db from docs/seed
npm run dev       # http://localhost:3000
npm test
```
