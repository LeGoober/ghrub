# 05 — Agent runbook (for FreeBuff)

You (FreeBuff) implement ghrub milestone by milestone. Rorisang + Claude Code
review commits and run CI/CD. Follow this loop exactly.

## The per-milestone loop
1. **Pick the milestone** from `03-milestones.md`. Read its deliverables + DoD.
2. `git checkout dev && git pull` then `git checkout -b feature/m{n}-<slug>`.
3. **Implement** against the specs in `01`, `02`, `06`. Small, focused commits
   with clear messages (`M{n}: add trip repository`). Do NOT batch unrelated
   work into one commit — Claude Code reads this history to gate promotion.
4. Keep `npm run lint`, `npm test`, `npm run build` green locally.
5. Run the **skill chain** below.
6. Open a PR `feature/... → dev`, title `M{n}: <summary>`, body cites DoD
   evidence + links the tracking issue.
7. Stop. Wait for review. Do not self-merge to `staging`/`main`.

## Skill chain (from `underground-terminal-skills`)
Point your agent at that bundle (copy the folders into `.claude/skills/` or
`.agents/skills/`, folder name = the skill's `name:`).

| When | Skill |
|------|-------|
| Any code change, before PR | `code-reviewer` — structured self-review; fix findings first |
| Any chart/graph (history, spend) | `dataviz` — form-first, validated palette |
| UI polish / visual direction (M5) | `frontend-design` → `ui-styling` / `ui-ux-pro-max` |
| Deciding scope / which track | `dual-track-workflow` — this is Track 1 (the product) |
| Brand / wordmark for ghrub | `brand`, `design` |

Then run built-in `/code-review` + verify before marking the PR ready
(mirrors the Underground Terminal rule).

## Hard rules
- **Extend the pattern, don't sprawl:** route → repository (`repo.js`) →
  service/insights → EJS view. No ORM. No new dependency unless Express +
  better-sqlite3 genuinely can't do it — justify it in the PR if so.
- **Money = integer cents.** Never store floats for money.
- **All DB access through `repo.js`.** Keeps the Postgres swap contained.
- **Every mutation returns an HTMX partial**, not a full page (see `06`).
- **Idempotent seed.** Re-running `npm run seed` must not duplicate rows.
- **Secrets never in code.** Read from `process.env`.

## If you switch to free-tier Postgres (instead of SQLite on a disk)
Contained change:
1. `npm i pg`, remove `better-sqlite3`.
2. In `repo.js`, replace the sqlite handle with a `pg.Pool` using
   `process.env.DATABASE_URL`; keep the same exported function names.
3. Port `schema.sql` types: `INTEGER PRIMARY KEY` → `SERIAL PRIMARY KEY`,
   `datetime('now')` → `now()`, `date('now')` → `current_date`.
4. Remove the `disk:` block from `render.yaml`; add `DATABASE_URL` from the
   Render Postgres instance.
Everything above `repo.js` stays untouched.

## Definition of Done gate (what Claude Code checks per PR)
- All milestone deliverables present; DoD behaviour demonstrable.
- CI green (lint + test + docker build + seed smoke).
- Commit history is coherent and scoped (no "wip"/"fix" dumps hiding the work).
- `code-reviewer` findings addressed.
Only then does it get promoted `dev → staging → main`.

---

## `/goal` — commit-history review + CI/CD to Render (Claude Code's job)
This is handled by Rorisang + Claude Code, not FreeBuff, but documented here so
the loop is visible:

1. **There is nothing to review until FreeBuff pushes commits.** Once the repo
   has a remote and commits land on `feature/*`/`dev`, Claude Code inspects
   `git log`/PR diffs against each milestone DoD.
2. Claude Code keeps CI green (reads failing Action runs, proposes fixes) and
   drives promotions `dev → staging → main`.
3. Deployment to Render is via the deploy-hook workflows (`04-devops-cicd.md`).
   The Render API key lives in your interactive terminal / GitHub secrets — not
   in Claude Code's sandboxed shell — so wiring the Render service + secrets is
   a one-time human step; after that, promotion auto-deploys.
4. To have Claude Code watch continuously as FreeBuff works, run a polling loop
   in an interactive session, e.g. `/loop 10m review latest commits and CI`.
