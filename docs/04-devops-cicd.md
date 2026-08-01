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
| `ci.yml` | PR to any branch + push to `dev` + `workflow_call` | install → lint → format → test → seed smoke → `docker build` |
| `deploy-staging.yml` | push to `staging` | run `ci.yml`, then `render-deploy-action` → **ghrub-staging** |
| `deploy-production.yml` | push to `main` | run `ci.yml`, then `render-deploy-action` → **ghrub** |

CI never needs secrets. Deploy workflows reuse your existing `RENDER_API_KEY`.

## Render deployment (mirrors Underground Terminal)

Same approach as your UT project: a **multi-service Blueprint** (`render.yaml`)
plus `johnbeynon/render-deploy-action` driven by your `RENDER_API_KEY`.
`autoDeploy` is off so CI gates every deploy.

### One-time setup
1. **Create services from the Blueprint.** Render Dashboard → **New → Blueprint**
   → pick the `ghrub` repo → it reads `render.yaml` and creates two web services:
   `ghrub` (branch `main`) and `ghrub-staging` (branch `staging`).
2. **Grab the service IDs.** Open each service; the URL / settings show
   `srv-xxxxxxxx`. Copy both.
3. **Add GitHub secrets** (repo → Settings → Secrets and variables → Actions):
   - `RENDER_API_KEY` — the key already in your terminal env
   - `RENDER_SERVICE_ID_STAGING` — the `ghrub-staging` srv-id
   - `RENDER_SERVICE_ID_PRODUCTION` — the `ghrub` srv-id
4. Push to `staging`/`main` → CI runs → the action deploys and waits for success.

### Local CLI alternative
`scripts/render-deploy.sh` triggers a deploy with `RENDER_API_KEY` +
`RENDER_SERVICE_ID` from your own shell (verify the API path against Render's
docs before automating on it).

> Note: this sandboxed shell can't see your terminal's `RENDER_API_KEY` (it's a
> non-interactive session). That's fine — CI reads it from GitHub secrets, and
> local scripts read it from your own shell. Never commit the key.

## `render.yaml` (blueprint)

- Two `web` services (`ghrub` on `main`, `ghrub-staging` on `staging`), Docker
  runtime, health check `/healthz`, `autoDeploy: false`.
- A **disk** mounted at `/data` for `ghrub.db` (SQLite persistence) — needs the
  `starter` plan, same paid tier UT already uses.
- Env: `NODE_ENV=production`, `DATABASE_PATH=/data/ghrub.db`, `PORT` (Render
  provides), `ENABLE_LLM=false`.
- Free-tier alternative: swap each `disk:` for a `postgresql` service via
  `fromDatabase` (exactly like UT), set `DATABASE_URL`, and switch `repo.js` to
  pg (see `05-agent-runbook.md`).

## Environment variables

| Var | Where | Purpose |
|-----|-------|---------|
| `PORT` | Render-provided | server port |
| `DATABASE_PATH` | render.yaml | SQLite file path (`/data/ghrub.db`) |
| `NODE_ENV` | render.yaml | `production` |
| `ENABLE_LLM` | render.yaml | `false` in MVP; gates M5 LLM feature |
| `ANTHROPIC_API_KEY` | secret (only if `ENABLE_LLM=true`) | latest Claude model |
| `GHRUB_PASSPHRASE` | secret (optional) | simple shared-secret gate |
| `RENDER_API_KEY` | GitHub secret | CI → Render deploy (render-deploy-action) |
| `RENDER_SERVICE_ID_STAGING` / `_PRODUCTION` | GitHub secret | which Render service each branch deploys |

## Local dev
```bash
npm install
npm run seed      # build + seed a local ghrub.db from docs/seed
npm run dev       # http://localhost:3000
npm test
```
