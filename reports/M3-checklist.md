# M3 — Multi-store price comparison — checklist

**Spec refs:** `docs/03-milestones.md` (M3) · `docs/02-data-model.md` ·
`docs/06-routes-and-ui.md` · `docs/05-agent-runbook.md`
**Branch:** `feature/m3-store-prices` → PR into `dev`
**Tracking issue:** #4
**DoD source:** "enter prices for a handful of items at 2+ stores; trip shows
correct per-store totals and picks the cheapest. CI green. ← end of MVP; tag a
`v0.1.0` release from `main`."

---

## Deliverables

| # | Deliverable | Ref | Lands in | Prove it | Expected | Done |
|---|-------------|-----|----------|----------|----------|------|
| 1 | Store-price entry UI | docs/03 | `src/views/stores/prices.ejs`, `src/routes/stores.js` | `npm test -- stores` | form + catalog type-ahead; POST returns a partial | ☑ |
| 2 | Remembers last price, shows seen date | docs/03 | `repo.latestPricesForItem` | `npm test -- stores` | "Last seen for Eggs: … R40.00 (2026-02-01)" | ☑ |
| 3 | Per-trip basket total per store | docs/03 | `src/lib/compare.js` | `npm test -- compare` | Checkers R60.00 vs Spar R64.00 | ☑ |
| 4 | Cheapest highlighted | docs/03 | `src/views/partials/compare.ejs` | `npm test -- stores` | `badge-cheapest` on the winning row | ☑ |
| 5 | Unpriced lines flagged, not zeroed | docs/02 | `src/lib/compare.js` | `npm test -- compare` | subtotal excludes them; `unpricedNames: ['Caviar']` | ☑ |
| 6 | "Cheapest per line" split-shop hint | docs/03 | `src/lib/compare.js` | `npm test -- compare` | split R59.00 vs Checkers R64.00 → saves R5.00 | ☑ |
| 7 | Prices are a history, latest wins | docs/02 | `repo.upsertStorePrice` | `npm test -- compare` | 2026-06-01 price beats the 2026-01-01 one | ☑ |

## Routes delivered (docs/06)

| Route | Behaviour |
|-------|-----------|
| `GET /stores/prices` | full page: entry form + recorded prices |
| `GET /stores/prices/suggest?q=` | catalog type-ahead `<ul>` |
| `POST /stores/prices` | record a price → rows partial (4xx + error partial on bad input) |
| `GET /trips/:id/compare` | partial: per-store totals, cheapest, split-shop hint |

## Verification commands (run and recorded)

```bash
npm run lint     # 0 errors, 0 warnings                      -> PASSED
npm run format   # All matched files use Prettier code style -> PASSED
npm test         # 9 files, 74 tests, all passing            -> PASSED
                 #   (52 before M3)
```

DoD walkthrough, run against a seeded DB:

```
stores: Checkers, Pick n Pay, Spar
POST /stores/prices  Rice @ Checkers 55.50  -> 200, partial, R55.50, 5550 cents
GET  /trips/:id/compare                     -> "Checkers is cheapest by R4.00"
                                               "Compared on the 2 of 2 lines priced at every store"
add unpriced "Bread"                        -> "1 unpriced" flag appears
```

## The decision a reviewer should check

**A store must not win by knowing fewer prices.** This is the one real trap in
M3 and it is easy to ship wrong. If Checkers has a price for 1 of your 3 lines
and Spar has all 3, then naive per-store sums are:

| Store | Naive sum | Lines priced |
|-------|-----------|--------------|
| Checkers | R10.00 | 1 of 3 |
| Spar | R61.00 | 3 of 3 |

…which "proves" Checkers is six times cheaper, purely by being ignorant. So:

- the **cheapest verdict is taken only on the comparable basket** — the lines
  every store can price;
- each store's **full subtotal and coverage are still shown**, so nothing is
  hidden, but they are labelled as not like-for-like;
- a comparison resting on **fewer than 2 lines, or under half the list**, is
  flagged `thinComparison` and the UI softens the claim instead of asserting it;
- the **split-shop saving is only quoted against a store that prices the same
  lines** — otherwise the same bias reappears in the saving figure;
- **ties are reported as ties**, not resolved arbitrarily.

Covered by `test/compare.test.js` → "does not let a store win by knowing fewer
prices".

## Gotchas re-checked (reports/README.md)

1. `.dockerignore` — no new `COPY`. ✔
2. Money stays integer cents: `toCents` on entry, `Math.round(price × qty)` once
   per line, asserted (`5550` for "55.50"). ✔
3. Idempotency: `store_price` is `UNIQUE(item_id, store_id, seen_date)`, so a
   same-day re-record updates instead of inserting — asserted. ✔
4. Docker build is CI's authority. ✔
5. Container smoke test still exercises the built image. ✔

## Commit history (scoped, reviewable)

- `M3: add store price history and basket comparison`
- `M3: add the prices page and the per-trip comparison panel`
- `M3: cover comparison, coverage bias and price history`
- `M3: record the M3 checklist`

## DoD statement (PR body)

> Prices for a handful of items across 2+ stores produce correct per-store
> basket totals, the cheapest store is highlighted, unpriced lines are flagged
> rather than zeroed, and a split-shop hint says when buying per-line beats one
> shop. 74 tests green (up from 52), lint + format clean. **End of MVP — tag
> `v0.1.0` from `main` after promotion.**
