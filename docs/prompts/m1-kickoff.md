# FreeBuff kickoff — Milestone M1

Paste everything in the fenced block below to FreeBuff as its opening
instruction. It is self-contained; FreeBuff starts cold and must read the spec.

---

```
You are building "ghrub", a personal grocery-intelligence web app, for its owner
Rorisang. The repository is https://github.com/LeGoober/ghrub (you have push
access via feature branches). The complete, authoritative spec lives in /docs —
read it before writing code, in this order:
  docs/README.md, docs/00-quick-decisions.md, docs/02-data-model.md,
  docs/06-routes-and-ui.md, docs/05-agent-runbook.md, docs/03-milestones.md.

The M0 scaffold already exists and is green: Node 20 + Express + EJS, ESLint 9 +
Prettier + Vitest, a Dockerfile, render.yaml, and GitHub Actions CI. Do NOT
rebuild it — extend it.

YOUR TASK THIS ROUND: implement Milestone M1 only ("Data layer + the running
list") exactly as specified in docs/03-milestones.md. Deliverables:
  1. Add better-sqlite3. In the Dockerfile, uncomment the alpine build-tools
     line (python3 make g++) so the native module compiles, and uncomment the
     `COPY docs/seed ./docs/seed` line so the seed data ships.
  2. src/db/schema.sql — the exact schema in docs/02-data-model.md.
  3. src/db/repo.js — ALL database access goes through here (thin repository;
     keeps a future Postgres swap contained). No ORM.
  4. A migration runner that applies schema.sql on boot if tables are missing.
  5. scripts/seed.js — idempotent import of docs/seed/grocery-history.json
     (categories, stores, items, trips, trip_items, recipes). Re-running must
     not duplicate rows (use INSERT ... ON CONFLICT). It must run headless in CI
     with no env set: default the DB path to ./data/ghrub.db and mkdir -p it.
  6. Trip CRUD + the trip workspace view and the list routes from
     docs/06-routes-and-ui.md: create a trip (name, start/end/shop dates,
     budget, target store), add items with type-ahead against the catalog, set
     category + estimate, tick bought + actual price, delete a line. Every
     mutation returns an HTMX partial (use hx-swap-oob for the budget bar), not
     a full-page reload.
  7. A live budget bar: subtotal (blend actual+est) vs budget, per-category
     subtotals, amber near budget / red over.

HARD RULES (from docs/05-agent-runbook.md):
  - Money stored as integer cents; render as R{value/100}. Never floats.
  - All DB access through src/db/repo.js.
  - Keep `npm run lint`, `npm run format`, and `npm test` green. Add Vitest
    tests for repo.js and the seed importer.
  - Small, scoped commits with clear messages ("M1: add trip repository") — the
    owner reviews commit history against the milestone DoD before promoting.
  - No new dependency beyond better-sqlite3 unless Express/EJS genuinely can't
    do it; justify any addition in the PR.

WORKFLOW:
  - git checkout dev && git pull, then git checkout -b feature/m1-data-list.
  - Before opening the PR, self-review with the `code-reviewer` skill (from the
    underground-terminal-skills bundle) and fix its findings; use `dataviz` only
    if you add a chart.
  - Open a pull request feature/m1-data-list -> dev, title "M1: data layer +
    running list", body listing each deliverable with evidence it meets the DoD:
    "create a trip, add >=10 items across categories, tick some bought, subtotal
    vs budget updates without full reloads; seed import covered by a test; CI
    green."
  - Do NOT merge to staging or main. Stop after the PR and wait for review.

DEFINITION OF DONE: the DoD line in docs/03-milestones.md for M1, with CI green
(lint + format + test + seed smoke + docker build).
```

---

## Gotchas (added after a review pass — read before coding)
- **`.dockerignore` excludes `docs`.** Uncommenting `COPY docs/seed ./docs/seed`
  alone makes `docker build` fail (context excludes `docs/`). Also add
  `!docs/seed` to `.dockerignore` (the repo now ships that fix).
- **Seed money is whole ZAR, schema is integer cents.** `grocery-history.json`
  stores `budget: 280`, `est: 20`; the seed must ×100 (`toCents`).
- **`trip` has no unique key**, so a bare `INSERT ... ON CONFLICT` can't make
  trips idempotent. Upsert trips by name lookup instead (`upsertTripByName`).

## After FreeBuff opens the PR
Rorisang + Claude Code review the commit history against the M1 DoD, then
promote `dev → staging → main`. For subsequent milestones, reuse this file as a
template: swap the milestone number, deliverables, DoD, and branch name.
