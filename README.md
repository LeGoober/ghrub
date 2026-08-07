# ghrub

> Your groceries, remembered.

A personal grocery intelligence app. Keep a running shopping list tied to a
planned shop date and a period (with a quirky name). When the day arrives, ghrub
reads your own history and tells you your **regulars**, what's **new** on this
list, whether you're on **budget**, the **cheapest store** for this basket, and
what you're **running low** on.

**Full spec lives in [`docs/`](docs/README.md) — start there.**

## Stack (locked — see [docs/00](docs/00-quick-decisions.md))
HTMX + Alpine · Node 20 + Express · EJS · Postgres on Neon (`pg`; SQLite until
the Neon migration) · Docker on Render · GitHub Actions CI/CD.

## Quick start (M0 scaffold)
```bash
npm install
npm test          # health + home render
npm run dev       # http://localhost:3000  (and /healthz)
```

## Pipeline
`feature/* → dev → staging → main`. CI on every PR; `staging`/`main` auto-deploy
to Render via deploy hooks. See [docs/04](docs/04-devops-cicd.md).

## Building this
Implemented milestone-by-milestone by a coding agent following
[docs/05-agent-runbook.md](docs/05-agent-runbook.md); commits reviewed and
CI/CD driven by Rorisang + Claude Code. Milestones + Definitions of Done in
[docs/03-milestones.md](docs/03-milestones.md).

## Status
- [x] M0 — scaffold: health check, tests, Docker, CI, Render blueprint
- [x] M1 — data layer + running list
- [x] M2 — habit intelligence (regulars / new / forgotten, `/history` charts)
- [x] M3 — store price comparison — **`v0.1.0`, end of MVP**
- [x] M4 — recipes + inventory (eat → deplete → restock)
- [x] M5 — polish + optional LLM — **`v0.2.0`**

**Not deployed yet.** Both deploy workflows fail at their secrets guard by
design until the Render services are wired up — see
[`reports/cicd-backtest.md`](reports/cicd-backtest.md) finding **B4** for the
three `gh secret set` commands that close it.

## Screens
`/` dashboard · `/trips` history · `/trips/:id` the workspace (list, budget bar,
habit buckets, store comparison, meal plan) · `/history` spend analytics ·
`/stores/prices` price book · `/recipes` · `/inventory`

## The optional LLM layer
"Explain this shop" is **off by default**. It needs `ENABLE_LLM=true` *and*
`ANTHROPIC_API_KEY`; without both, the route 404s and nothing else changes.
It is one `fetch` call to the Messages API — no SDK dependency.
