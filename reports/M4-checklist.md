# M4 — Recipes → inventory loop — checklist

**Spec refs:** `docs/03-milestones.md` (M4) · `docs/02-data-model.md` ·
`docs/06-routes-and-ui.md` · `docs/05-agent-runbook.md`
**Branch:** `feature/m4-recipes-inventory` → PR into `dev`
**Tracking issue:** #5
**DoD source:** "log a seeded recipe as eaten → its ingredients' inventory
drops; an item crossing its threshold appears as a suggestion on a new trip.
CI green."

---

## Deliverables

| # | Deliverable | Ref | Lands in | Prove it | Expected | Done |
|---|-------------|-----|----------|----------|----------|------|
| 1 | Recipe catalog (seeded) + editor | docs/03 | `src/views/recipes/index.ejs`, `src/routes/kitchen.js` | `npm test -- kitchen` | 16 seeded recipes render; editor replaces the ingredient set | ☑ |
| 2 | Meal-plan grid on the trip period | docs/03 | `src/views/partials/meal-plan.ejs`, `kitchen.planDays` | `npm test -- kitchen` | 7 day rows for a 10–16 Aug trip; clearing a cell deletes the row | ☑ |
| 3 | Inventory table | docs/03 | `src/views/inventory/index.ejs` | `npm test -- kitchen` | track item, +/- nudge, low flag | ☑ |
| 4 | "Log meal eaten" decrements ingredients | docs/03 | `src/lib/kitchen.js` | `npm test -- kitchen` | Chicken Alfredo: 3 ingredients 2 → 1 | ☑ |
| 5 | Buying (✓) restocks | docs/03 | `src/routes/trips.js` + `applyBoughtToInventory` | `npm test -- kitchen` | qty 2 ticked: 1 → 3; edited again: still 3 | ☑ |
| 6 | Low-stock alerts feed next trip's suggestions | docs/03 | `lowStockSuggestions`, `BUCKET_DEFS` | `npm test -- kitchen` | "Running low" bucket on a new trip names them | ☑ |

## Routes delivered (docs/06)

| Route | Behaviour |
|-------|-----------|
| `GET /recipes` | full page: catalog, meal log, "Ate this" |
| `POST /recipes` | create → recipe card partial |
| `GET /recipes/:id` | recipe card partial |
| `POST /recipes/:id/ingredients` | replace the ingredient set → card partial |
| `DELETE /recipes/:id` | remove |
| `GET /inventory` | full page: table + low-stock banner |
| `POST /inventory` | track an item → table partial (4xx + error on bad input) |
| `PATCH /inventory/:itemId` | delta nudge or overwrite → table partial |
| `POST /meals/log` | log eaten → drawdown partial + low-stock warning |
| `GET /trips/:id/plan` | meal-plan grid partial |
| `POST /trips/:id/plan` | set/clear a cell → grid partial |

## Verification commands (run and recorded)

```bash
npm run lint     # 0 errors, 0 warnings                      -> PASSED
npm run format   # All matched files use Prettier code style -> PASSED
npm test         # 10 files, 101 tests, all passing          -> PASSED
                 #   (74 before M4)
```

DoD walkthrough against a seeded DB:

```
recipe: Chicken Alfredo | ingredients: Alfredo sauce, Chicken breasts, Pasta
before: Alfredo sauce=2, Chicken breasts=2, Pasta=2
POST /meals/log -> 200, "Drew down 3 ingredients"
after : Alfredo sauce=1, Chicken breasts=1, Pasta=1
low stock now: Alfredo sauce, Chicken breasts, Pasta
new trip shows "Running low" bucket naming all three            <- DoD met

Pasta stock: before=1 afterBuy=3 afterPriceEdit=3 afterUntick=1  <- no double-count
meal plan grid: 200 | 8 day rows
```

## The decision a reviewer should check

**Stock moves on transitions, not on saves.** `PATCH /trips/:id/items/:lineId`
fires for *any* line edit — ticking bought, changing qty, typing an actual
price. If restocking keyed off "bought is 1" rather than "bought just became
1", then editing the price of a ticked line would silently add another unit
every keystroke-triggered save. So `applyBoughtToInventory` takes both the
before and after value and returns `null` when they match.

The symmetric cases are handled too: un-ticking a line, and deleting a line
that was already ticked, both take the stock back off. Deleting an *unticked*
line moves nothing.

Second decision: **only items with an inventory row are "tracked".** An item
with no row is not being counted, which is different from being at zero —
otherwise all 100 seeded catalog items would have reported as running low the
moment M4 shipped.

Third: **a free-text meal moves no stock.** ghrub does not know what
"leftovers" was made of, and guessing would quietly corrupt the counts.

## Gotchas re-checked (reports/README.md)

1. `.dockerignore` — no new `COPY`. ✔
2. Money: M4 touches quantities, not money; no cents involved. ✔
3. Idempotency: `setMealPlanCell` deletes before inserting, so re-posting a
   cell cannot duplicate it; `setRecipeIngredients` replaces the set wholesale;
   the seed is untouched and still imports twice with identical counts. ✔
4. Docker build is CI's authority. ✔
5. Container smoke test still exercises the built image. ✔

## Commit history (scoped, reviewable)

- `M4: add recipe, inventory and meal-log data access plus the kitchen rules`
- `M4: close the eat -> deplete -> restock loop in the UI`
- `M4: cover the loop, including the ways it could double-count`
- `M4: record the M4 checklist`

## DoD statement (PR body)

> Logging the seeded "Chicken Alfredo" as eaten drops all three of its
> ingredients from 2 to 1; all three cross their threshold and appear in a new
> trip's "Running low" bucket, each one a one-tap add. Ticking a line bought
> restocks it, and editing that line again does not restock it twice. 101 tests
> green (up from 74), lint + format clean.
