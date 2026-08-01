# ghrub — Spec

**ghrub** is a personal grocery intelligence app. You keep a running shopping
list tied to a planned shop date and a period (with a quirky name, e.g.
*"Bambezela Spezial V4"*, *"The Lenten Guide"*). When the day arrives, ghrub
reads your history and tells you: what you *always* buy (regulars), what's
*new* on this list, whether you're on budget, which store is cheapest for this
basket, and what you're running low on based on the meals you've logged.

This `docs/` folder is the single source of truth. It is written to be
executed by a coding agent (FreeBuff) milestone by milestone, with a human
(Rorisang) and Claude Code handling git review + CI/CD to Render.

## Read in this order

| # | Doc | What it covers |
|---|-----|----------------|
| 00 | [Quick decisions](00-quick-decisions.md) | The stack, locked. Why HTMX + Node + SQLite + Docker on Render. |
| 01 | [Product spec](01-product-spec.md) | Features, the "AI automation", user flows, MVP scope line. |
| 02 | [Data model](02-data-model.md) | Entities, schema, the seed import. |
| 03 | [Milestones](03-milestones.md) | M0–M5, each a GitHub-tracked delivery with a definition of done. |
| 04 | [DevOps & CI/CD](04-devops-cicd.md) | Branches (dev/staging/main), GitHub Actions, Render deploy, secrets. |
| 05 | [Agent runbook](05-agent-runbook.md) | How FreeBuff works each milestone; which skills to chain; DoD gates. |
| 06 | [Routes & UI](06-routes-and-ui.md) | HTMX endpoints, page map, partial-swap conventions. |
| — | [seed/grocery-history.json](seed/grocery-history.json) | Rorisang's real history, machine-readable. Powers habits + baselines. |

## The one-line MVP

> Create a dated shopping list, tick items off by category against a budget,
> and get told your regulars, your new items, your cheapest store, and your
> low-stock items — all from your own history.

Everything past that line is post-MVP (see milestone tags `[MVP]` vs `[v0.2]`).

## Conventions inherited from `underground-terminal-skills`

- **Branch flow:** `feature/* → dev → staging → main` (main = production).
  (Your Underground Terminal workflow calls production `prod`; here it's
  `main` per this project's request — same role.)
- **Skill chain per change:** implement → `code-reviewer` → built-in
  `/code-review` + verify before promoting a branch.
- **Deploy:** Render, driven by `render.yaml` blueprint.
- **Extend, don't sprawl:** new capability follows the existing
  route → repository → service pattern; no new dependency unless the current
  stack genuinely can't do it.
