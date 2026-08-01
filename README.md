# ghrub

> Your groceries, remembered.

A personal grocery intelligence app. Keep a running shopping list tied to a
planned shop date and a period (with a quirky name). When the day arrives, ghrub
reads your own history and tells you your **regulars**, what's **new** on this
list, whether you're on **budget**, the **cheapest store** for this basket, and
what you're **running low** on.

**Full spec lives in [`docs/`](docs/README.md) — start there.**

## Stack (locked — see [docs/00](docs/00-quick-decisions.md))
HTMX + Alpine · Node 20 + Express · EJS · SQLite (better-sqlite3, from M1) ·
Docker on Render · GitHub Actions CI/CD.

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
- [x] M0 — scaffold (this commit): health check, tests, Docker, CI, Render blueprint
- [ ] M1 — data layer + running list
- [ ] M2 — habit intelligence
- [ ] M3 — store price comparison
- [ ] M4 — recipes + inventory
- [ ] M5 — polish + optional LLM
