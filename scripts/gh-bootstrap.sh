#!/usr/bin/env bash
# GitHub setup for ghrub: labels, milestones, tracking issues, branch protection.
# Requires the `gh` CLI, authenticated (`gh auth login`), run from repo root
# with a remote already set.
#
# Idempotent — safe to re-run. It creates what is missing and leaves the rest
# alone, so it doubles as a drift check on the governance in docs/03 + docs/04.
set -euo pipefail

REPO="$(gh repo view --json nameWithOwner --jq .nameWithOwner)"
echo "Repo: $REPO"

# ---------------------------------------------------------------- labels ----
echo "==> Labels"
gh label create "MVP"       --color 2da44e --description "Ships in v0.1 MVP"        2>/dev/null || true
gh label create "v0.2"      --color 8250df --description "Post-MVP"                 2>/dev/null || true
gh label create "milestone" --color 0969da --description "Milestone tracking issue" 2>/dev/null || true

# ------------------------------------------------------------ milestones ----
echo "==> Milestones"
create_ms () {
  if gh api "repos/$REPO/milestones" --jq '.[].title' | grep -qxF "$1"; then
    echo "    = $1"
  else
    gh api "repos/$REPO/milestones" -f title="$1" -f description="$2" >/dev/null
    echo "    + $1"
  fi
}
create_ms "M0 Foundations & pipeline"      "Repo, CI, Docker, Render deploy green"
create_ms "M1 Data layer + running list"   "Schema, seed, trip CRUD, list + budget bar"
create_ms "M2 Habit intelligence"          "Regulars / new / forgotten, spend history"
create_ms "M3 Store price comparison"      "Per-store basket totals, cheapest store"
create_ms "M4 Recipes + inventory"         "Meal log decrements inventory, low-stock alerts"
create_ms "M5 Polish + optional LLM"       "Design pass, PWA, LLM summary behind a flag"

# -------------------------------------------------- tracking issues (M0-M5) --
# docs/03-milestones.md § Tracking convention: one tracking issue per milestone,
# checklist = that milestone's deliverables.
echo "==> Tracking issues"
create_issue () {
  local title="$1" milestone="$2" label="$3" body="$4"
  if gh issue list --state all --limit 100 --json title --jq '.[].title' | grep -qxF "$title"; then
    echo "    = $title"
    return
  fi
  gh issue create --title "$title" --milestone "$milestone" \
    --label "milestone" --label "$label" --body "$body" >/dev/null
  echo "    + $title"
}

create_issue "M0 — Foundations & pipeline" "M0 Foundations & pipeline" "MVP" \
'Tracking issue for M0 (see `docs/03-milestones.md`).

- [x] Repo initialised; branches `dev`/`staging`/`main`
- [x] `package.json`, Express server, `GET /healthz` -> 200
- [x] `Dockerfile` + `.dockerignore` build a runnable image
- [x] `render.yaml` blueprint (web service + disk)
- [x] Actions: `ci.yml`, `deploy-staging.yml`, `deploy-production.yml`
- [x] `docs/` present
- [ ] **Render services created + secrets set; live `/healthz` returns 200**

**DoD:** PR to `dev` green; merged to `main`; Render shows a live URL whose
`/healthz` returns 200.

> Blocked on a human step: `RENDER_API_KEY`, `RENDER_SERVICE_ID_STAGING` and
> `RENDER_SERVICE_ID_PRODUCTION` are unset, so both deploy workflows fail at the
> guard. See `reports/cicd-backtest.md` finding **B4**.'

create_issue "M1 — Data layer + the running list" "M1 Data layer + running list" "MVP" \
'Tracking issue for M1 (see `docs/03-milestones.md`).

- [x] `schema.sql` applied via a migration runner; `repo.js` data access
- [x] `scripts/seed.js` imports `docs/seed/grocery-history.json` (idempotent)
- [x] Trip CRUD: create, list, open, mark status
- [x] Trip list view: add item (type-ahead), category, est price; tick bought +
      actual price; delete line — all HTMX partial swaps
- [x] Live budget bar: subtotal vs budget, per-category subtotals

**DoD:** create the "next shop" trip, add >= 10 items across categories, tick
some bought, see subtotal vs budget update without full page reloads. Seed
import covered by a test. CI green.

Evidence: `reports/M1-checklist.md`.'

create_issue "M2 — Habit intelligence" "M2 Habit intelligence" "MVP" \
'Tracking issue for M2 (see `docs/03-milestones.md`).

- [ ] `insights.js`: regulars (>=50%), new-this-list, often-forgotten, spend
      history (avg per trip + per category), cadence -> suggested next shop date
- [ ] Trip view: three suggestion buckets with one-tap "add" (HTMX)
- [ ] `/history` dashboard: past trips, totals, category averages

**DoD:** opening a fresh trip surfaces correct regulars from seed (Eggs, Oats,
Chicken, Noodles, Spinach...); "add all regulars" works; history page renders.
CI green.'

create_issue "M3 — Multi-store price comparison" "M3 Store price comparison" "MVP" \
'Tracking issue for M3 (see `docs/03-milestones.md`).

- [ ] Store-price entry UI (per item, remembers last price, shows seen date)
- [ ] Per-trip basket total at each store; cheapest highlighted; unpriced lines
      flagged, not zeroed
- [ ] "Cheapest per line" split-shop hint

**DoD:** enter prices for a handful of items at 2+ stores; trip shows correct
per-store totals and picks the cheapest. CI green. End of MVP — tag `v0.1.0`
from `main`.'

create_issue "M4 — Recipes -> inventory loop" "M4 Recipes + inventory" "v0.2" \
'Tracking issue for M4 (see `docs/03-milestones.md`).

- [ ] Recipe catalog (seeded) + editor; meal-plan grid on the trip period
- [ ] Inventory table; "log meal eaten" decrements ingredients; buying restocks
- [ ] Low-stock alerts feed next trip'"'"'s suggestions

**DoD:** log a seeded recipe as eaten -> its ingredients'"'"' inventory drops; an
item crossing its threshold appears as a suggestion on a new trip. CI green.'

create_issue "M5 — Polish + optional LLM" "M5 Polish + optional LLM" "v0.2" \
'Tracking issue for M5 (see `docs/03-milestones.md`).

- [ ] Design pass (mobile-first, aisle-usable, >=44px tap targets)
- [ ] Optional "Explain this shop" via the latest Claude model, behind `ENABLE_LLM`
- [ ] PWA manifest / installable; empty + error states

**DoD:** Lighthouse mobile pass; LLM flag off by default and the app fully works
without it; tag `v0.2.0`.'

# --------------------------------------------------- branch protection ------
# docs/04-devops-cicd.md: on `main` and `staging` require a PR + a passing `ci`
# check; disallow direct pushes. `dev` gets the same gate because every feature
# branch lands there first.
#
# Deliberate settings for a solo repo:
#   required_approving_review_count: 0  — a solo dev cannot approve their own PR,
#                                         so requiring 1 would deadlock the flow.
#   enforce_admins: false               — leaves the owner an escape hatch.
# The CI gate is the part that actually matters: no red build reaches a branch.
echo "==> Branch protection"
protect () {
  local branch="$1"
  if ! git ls-remote --exit-code --heads origin "$branch" >/dev/null 2>&1; then
    echo "    ! $branch does not exist on origin — skipping"
    return
  fi
  gh api -X PUT "repos/$REPO/branches/$branch/protection" \
    --input - >/dev/null <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["build-test", "docker"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": true
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON
  echo "    + $branch (PR required; ci build-test + docker must pass)"
}
protect dev
protect staging
protect main

echo
echo "Done. See docs/03-milestones.md for each milestone's deliverables + DoD,"
echo "and reports/cicd-backtest.md for the governance audit this enforces."
