# M2 — Habit intelligence — checklist

**Spec refs:** `docs/03-milestones.md` (M2) · `docs/02-data-model.md` ·
`docs/06-routes-and-ui.md` · `docs/05-agent-runbook.md`
**Branch:** `feature/m2-habit-intelligence` → PR into `dev`
**Tracking issue:** #3
**DoD source:** "opening a fresh trip surfaces correct regulars from seed (Eggs,
Oats, Chicken, Noodles, Spinach…); 'add all regulars' works; history page
renders. CI green."

---

## Deliverables

| # | Deliverable | Ref | Lands in | Prove it | Expected | Done |
|---|-------------|-----|----------|----------|----------|------|
| 1 | `insights.js`: regulars ≥50% | docs/03 | `src/lib/insights.js` | `npm test -- insights` | all 8 regulars docs/02 predicts are surfaced | ☑ |
| 2 | new-this-list | docs/03 | `src/lib/insights.js` | `npm test -- insights` | only items with no history; `Eggs` excluded | ☑ |
| 3 | often-forgotten | docs/03 | `src/lib/insights.js` | `npm test -- insights` | ≥3 past lists, not listed now, not already a regular | ☑ |
| 4 | spend history (avg/trip + per category) | docs/02 | `src/lib/insights.js` | `npm test -- insights` | integer cents; 11 trips; over/budgeted counts | ☑ |
| 5 | cadence → suggested next shop date | docs/03 | `src/lib/insights.js` | `npm test -- insights` | median 23 days, next ≈ last + 23 | ☑ |
| 6 | Three buckets with one-tap add (HTMX) | docs/06 | `src/routes/trips.js`, `src/views/partials/insight-bucket*.ejs` | `npm test -- history` | buckets render; chip add drops the item from its bucket | ☑ |
| 7 | "Add all regulars" | docs/03 | `POST /trips/:id/insights/add-regulars` | `npm test -- history` | 12 lines added; idempotent on re-post; OOB bar + buckets | ☑ |
| 8 | `/history` dashboard with charts | docs/03, docs/06 | `src/routes/history.js`, `src/views/history.ejs`, `src/lib/charts.js` | `npm test -- history` | hero + 2 SVG charts + table view; no `NaN` | ☑ |
| 9 | Charts via the `dataviz` skill | docs/05 | `src/lib/charts.js`, `public/css/app.css` | palette validator output below | mark colour passes all six checks | ☑ |

## Routes delivered (docs/06)

| Route | Behaviour |
|-------|-----------|
| `GET /trips/:id/insights/regulars` | bucket partial + "Add all" |
| `GET /trips/:id/insights/new` | new-this-list partial |
| `GET /trips/:id/insights/forgotten` | often-forgotten partial |
| `POST /trips/:id/insights/add-regulars` | bulk add → lists partial + OOB bar + OOB buckets |
| `GET /history` | full page: hero, KPI row, 2 charts, table view |

## Verification commands (run and recorded)

```bash
npm run lint     # 0 errors, 0 warnings                     -> PASSED
npm run format   # All matched files use Prettier code style -> PASSED
npm test         # 7 files, 52 tests, all passing            -> PASSED
                 #   (was 4 files / 22 tests before M2)
```

**Palette validation** (`dataviz` skill — run, not eyeballed):

```bash
node scripts/validate_palette.js "#1f6f4a" --mode light
#   [FAIL] Chroma floor   below floor (reads gray): #1f6f4a 0.097
node scripts/validate_palette.js "#12855a" --mode light
#   -> ALL CHECKS PASS
node scripts/validate_palette.js "#12855a,#c94b3d" --mode light
#   [WARN] CVD separation  worst adjacent ΔE 7.8 (deutan)
#   -> legal only WITH secondary encoding; see decision 3 below
```

## Decisions a reviewer should check

1. **Regulars count *listed*, not *bought*.** `docs/02`'s sketch SQL filters
   `bought = 1`, but that filter cannot produce the regulars the same document
   says to expect. Oats is listed on 6 of 10 trips and bought on 2, so
   `bought = 1` drops it — while both `docs/02` and the M2 DoD name Oats a
   regular. Writing an item down is the habit; whether you got it that week is
   a separate signal, kept as `trips_bought` and shown as "6 lists · bought 2".
   Result: all 8 predicted regulars surface. **Chicken breasts sits at 4/10 =
   40%**, just under the bar, and surfaces in *often forgotten* instead — still
   on the same screen, in the bucket that fits it.
2. **Cadence uses the median gap, not the mean.** Seed gaps are
   15, 15, 27, 31, 137, 6, 56, 14, 19 days. The 137-day Jul→Dec hole drags the
   mean to ~36 days; the median says 23, which is the real rhythm.
3. **Over-budget is never colour alone.** Green vs red measures ΔE 1.7 under
   protanopia — indistinguishable. The overshoot is therefore a *separate
   stacked segment* with an "over" label; the 7.8 ΔE colour only reinforces
   geometry that already reads without it. Every value is also in the table
   view, so nothing is gated behind hover.
4. **Buckets refresh out-of-band on every list mutation.** Adding a line
   changes what is new, forgotten and already-listed; a stale bucket would keep
   offering an item you just added.

## Gotchas re-checked (reports/README.md)

1. `.dockerignore` — no new `COPY` added, nothing to break. ✔
2. Money stays integer cents: averages use `CAST(ROUND(AVG(...)) AS INTEGER)`,
   asserted by `Number.isInteger` in the tests. ✔
3. Idempotency: `add-regulars` posts twice without duplicating lines (test). ✔
4. Docker build is CI's authority — no local Docker change in M2. ✔
5. Green `docker build` ≠ working image: the container smoke test added in the
   CI/CD backtest exercises `/` and `/trips` on the built image. ✔

## Known gaps (deliberate, deferred to M5)

- The charts are light-mode only, because the app is. `dataviz` asks for a
  *selected* dark mode, not an automatic flip — that belongs in M5's design
  pass, not bolted onto two charts in a light-only app.
- Hover is native SVG `<title>` (zero-JS, works everywhere). Richer crosshair
  tooltips would need client JS; the table view already ungates every value.

## Commit history (scoped, reviewable)

- `M2: add habit intelligence queries and insights engine`
- `M2: surface habit buckets on the trip workspace`
- `M2: add the /history spend dashboard`
- `M2: record the M2 checklist`

## DoD statement (PR body)

> Opening a fresh trip surfaces the regulars `docs/02` predicts from the seed
> (Spinach, Eggs, Bell peppers, Chickpeas, Noodles, Oats, Tomatoes, Tuna);
> "Add all" adds all 12 missing regulars in one tap and is idempotent; the
> `/history` page renders a hero figure, two validated inline-SVG charts and a
> table view. 52 tests green (up from 22), lint + format clean.
