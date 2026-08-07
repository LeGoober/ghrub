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

**Branch protection:** applied by `scripts/gh-bootstrap.sh` to `dev`, `staging`
and `main` — PR required, `build-test` + `docker` must pass, branch must be up
to date, no force-push, no deletion. Calibrated for a solo repo: 0 required
approvals (you cannot approve your own PR) and admins not enforced. Re-run the
script any time; it is idempotent and doubles as a drift check.

## GitHub Actions

Three workflows in `.github/workflows/`:

| Workflow | Trigger | Does |
|----------|---------|------|
| `ci.yml` | PR to any branch + push to `dev` + `workflow_call` | install → lint → format → test → **seed twice (idempotency)** → `docker build` → **container smoke test** |
| `deploy-staging.yml` | push to `staging`, or manual | run `ci.yml`, then `render-deploy-action` → **ghrub-staging**, then verify live `/healthz` |
| `deploy-production.yml` | push to `main`, or manual | run `ci.yml`, then `render-deploy-action` → **ghrub**, then verify live `/healthz` |

CI never needs secrets. Deploy workflows reuse your existing `RENDER_API_KEY`.

**Why the container smoke test exists:** `docker build` proves the image
compiles, never that it runs. M1's better-sqlite3 SIGSEGV built green and
crashed on boot (`reports/cicd-backtest.md` finding B5). CI now boots the image,
waits for `/healthz`, drives the DB-backed routes `/` and `/trips`, and asserts
the container is still alive afterwards — exit 139 is a segfault.

**Post-deploy verification:** set repo *variables* `STAGING_URL` and
`PRODUCTION_URL` (e.g. `https://ghrub.onrender.com`) and each deploy workflow
polls the live `/healthz` after deploying. Without them the step is skipped, so
"Render says deployed" is the only assurance you get.

## Render deployment (mirrors Underground Terminal)

Same approach as your UT project: a **multi-service Blueprint** (`render.yaml`)
plus `johnbeynon/render-deploy-action` driven by your `RENDER_API_KEY`.
`autoDeploy` is off so CI gates every deploy.

### One-time setup
> **Status: not done.** Both deploy workflows currently fail at their secrets
> guard, so nothing is deployed and M0's DoD is still open. See
> `reports/cicd-backtest.md` finding **B4**.

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
- **No disk, `plan: free`.** Storage is Neon Postgres, so the services are
  stateless and need no paid instance type.
- Env: `NODE_ENV=production`, `DATABASE_URL` (Neon, `sync: false` so Render
  prompts for it and it never lands in git), `PORT` (Render provides),
  `ENABLE_LLM=false`.
- **Keep `region: ohio`** — it matches the Neon project's `us-east-2`. A page
  render makes several queries; moving the service to another continent adds
  that round trip to each one.
- Point staging at a **separate Neon branch**, or its deploys overwrite the
  real grocery history.

## Environment variables

| Var | Where | Purpose |
|-----|-------|---------|
| `PORT` | Render-provided | server port |
| `DATABASE_URL` | Render dashboard (`sync: false`) | Neon Postgres connection string; keep `?sslmode=require` |
| `NODE_ENV` | render.yaml | `production` |
| `ENABLE_LLM` | render.yaml | `false` in MVP; gates M5 LLM feature |
| `ANTHROPIC_API_KEY` | secret (only if `ENABLE_LLM=true`) | latest Claude model |
| `GHRUB_PASSPHRASE` | secret (optional) | simple shared-secret gate |
| `RENDER_API_KEY` | GitHub secret | CI → Render deploy (render-deploy-action) |
| `RENDER_SERVICE_ID_STAGING` / `_PRODUCTION` | GitHub secret | which Render service each branch deploys |

## Local dev
```bash
npm install
npm run seed      # seed the DATABASE_URL database from docs/seed
npm run dev       # http://localhost:3000
npm test
```
