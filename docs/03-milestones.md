# 03 — Milestones (GitHub-tracked deliveries)

Each milestone = one **GitHub Milestone** + a tracking issue + a PR into `dev`.
Promotion `dev → staging → main` happens once its Definition of Done (DoD) is
green. Tag issues `[MVP]` or `[v0.2]`. CI must be green before any promotion.

Create the GitHub milestones with the gh CLI (see `scripts/gh-bootstrap.sh`).

---

## M0 — Foundations & pipeline `[MVP]`  ← mostly pre-built in this scaffold
**Goal:** an empty-but-real app that builds, tests, containerises, and deploys
to Render on a green pipeline. Everything after this is just adding features.

Deliverables:
- Repo initialised, branches `dev`/`staging`/`main`, branch protection notes.
- `package.json`, Express server with `GET /healthz` → `200 {ok:true}` and a
  placeholder home page.
- `Dockerfile` + `.dockerignore` build a runnable image.
- `render.yaml` blueprint (web service + disk).
- GitHub Actions: `ci.yml` (install → lint → test → docker build) on every PR;
  `deploy-staging.yml` and `deploy-production.yml` calling the Render deploy hook.
- `docs/` present (this folder).

**DoD:** PR to `dev` is green; merged to `main`; Render shows a live URL whose
`/healthz` returns 200. **Status: scaffold provided by Claude Code — FreeBuff
verifies + wires the Render service.**

---

## M1 — Data layer + the running list `[MVP]`
**Goal:** create a dated trip and manage its list.

Deliverables:
- `schema.sql` applied via a migration runner; `repo.js` data access.
- `scripts/seed.js` imports `docs/seed/grocery-history.json` (idempotent).
- Trip CRUD: create (name, start/end/shop dates, budget, target store), list,
  open, mark status.
- Trip list view: add item (type-ahead on catalog), set category, est price;
  tick bought + actual price; delete line. All mutations are HTMX partial swaps.
- Live budget bar: subtotal vs budget, per-category subtotals.

**DoD:** can create the "next shop" trip, add ≥ 10 items across categories, tick
some bought, see subtotal vs budget update without full page reloads. Seed import
covered by a test. CI green.

---

## M2 — Habit intelligence `[MVP]`
**Goal:** the app tells you about your own habits.

Deliverables:
- `insights.js`: regulars (≥50%), new-this-list, often-forgotten, spend history
  (avg per trip + per category), cadence → suggested next shop date.
- On the trip view: three suggestion buckets with one-tap "add" (HTMX).
- A `/history` dashboard: past trips, totals, category averages (use `dataviz`
  skill for the charts).

**DoD:** opening a fresh trip surfaces correct regulars from seed (Eggs, Oats,
Chicken, Noodles, Spinach…); "add all regulars" works; history page renders.
CI green.

---

## M3 — Multi-store price comparison `[MVP]`
**Goal:** know the cheapest place to buy this basket.

Deliverables:
- Store-price entry UI (per item, remembers last price, shows seen date).
- Per-trip basket total at Checkers / Spar / Pick n Pay; cheapest highlighted;
  unpriced lines flagged, not zeroed.
- "Cheapest per line" split-shop hint.

**DoD:** enter prices for a handful of items at 2+ stores; trip shows correct
per-store totals and picks the cheapest. CI green. **← end of MVP; tag a
`v0.1.0` release from `main`.**

---

## M4 — Recipes → inventory loop `[v0.2]`
**Goal:** close the eat → deplete → restock loop.

Deliverables:
- Recipe catalog (seeded) + editor; meal-plan grid on the trip period.
- Inventory table; "log meal eaten" decrements ingredients; buying (✓) restocks.
- Low-stock alerts feed next trip's suggestions.

**DoD:** log a seeded recipe as eaten → its ingredients' inventory drops; an
item crossing its threshold appears as a suggestion on a new trip. CI green.

---

## M5 — Polish + optional LLM `[v0.2]`
**Goal:** ship-quality + optional narrative insight.

Deliverables:
- `frontend-design` + `ui-styling` pass (mobile-first, aisle-usable).
- Optional "Explain this shop" via latest Claude model, behind `ENABLE_LLM`.
- PWA manifest / installable; empty + error states.

**DoD:** Lighthouse mobile pass; LLM flag off by default and app fully works
without it; tag `v0.2.0`.

---

## Tracking convention
- One tracking issue per milestone, checklist = the deliverables above.
- PR title: `M{n}: <summary>`; body links the issue and states DoD evidence.
- Claude Code reviews each PR's commit history against the DoD before promotion
  (see the `/goal` note in `05-agent-runbook.md`).
