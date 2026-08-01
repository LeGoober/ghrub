# 01 — Product spec

Single-user (you). No auth in MVP beyond an optional shared passphrase env var.
Mobile-first — this gets used standing in a shop aisle.

## Core objects (user's mental model)

- **Trip** — a planned shop. Has a **quirky name**, a **period** (start → end,
  "how long these groceries should last"), a **budget**, and a status:
  `planning → shopping → done`. This is the thing you open and add to.
- **List items** — lines on a trip, grouped by **category**. Each has an
  estimated price, an actual price, and a bought flag (✓/◦), mirroring exactly
  how you already write your lists.
- **Meal plan** — the breakfast/lunch/lunch-2/dinner/dessert grid per day of
  the period. Optional, but it's how recipes connect to the list.
- **Recipe** — a named meal mapped to ingredient items.
- **Inventory** — what you have at home right now, per item.
- **Store price** — a price you saw for an item at Checkers / Spar / Pick n Pay.

## Features by theme

### 1. The running list (the daily driver) `[MVP]`
- Create a trip: name, start date, end date, budget, target store(s).
- Add items fast: type-ahead against the **item catalog** (seeded from your
  history), pick/confirm category, optional estimate.
- Tick items bought (✓) with an actual price; strike-through, subtotal updates
  live via HTMX partial swap.
- Live **budget bar**: subtotal (est + actual blend) vs budget, per-category
  breakdown, over/under indicator.

### 2. Habit intelligence (the "AI") `[MVP]`
- On opening a trip near its date, ghrub shows three buckets:
  - **Your regulars** — bought in ≥ 50% of past trips; one-tap add-all.
  - **New this list** — items not seen (or seen <2×) before, flagged so you
    notice unusual spend.
  - **You often forget** — items frequent in history but *absent* from the
    current list (e.g. you added Oats 8 times but not this trip).
- **Spend history**: average total per trip, average per category, trend.
- **Cadence**: average period length (your trips run ~2 weeks) → suggests the
  next shop date.

### 3. Multi-store price comparison `[MVP]`
- Manually record item prices per store (fast entry, remembers last price).
- For any trip, compute the **basket total at each store** and highlight the
  cheapest, plus "split shop" hint (cheapest store per line).
- Prices are your own historic data; each shows its record date so stale
  prices are visible.

### 4. Recipes → inventory loop `[v0.2]`
- Recipe catalog seeded from your meals (see `recipes_seed` in the seed file).
- Plan meals onto the period grid.
- **Log a meal eaten** → decrement each ingredient's inventory.
- **Low-stock alerts** → items under threshold surface as suggestions on the
  next trip ("running low: Oats, Eggs").
- Buying an item on a trip (✓) can **restock** inventory.

### 5. Optional LLM summary `[v0.2]`
- One button: "Explain this shop." Sends the computed numbers (not raw data
  dumps) to the latest Claude model and returns a short plain-English brief:
  what's driving cost, what changed vs last time, one budget tip.
- Feature-flagged (`ENABLE_LLM=false` by default). App is fully usable without
  it.

## Explicit MVP scope line

**In MVP (M0–M3):** trips, dated lists, category budgets, item catalog +
type-ahead, habit buckets (regulars/new/forgotten), spend history, multi-store
basket comparison. Deployed to Render, green pipeline.

**Post-MVP (M4–M5, `[v0.2]`):** meal-plan grid, recipe→inventory decrement,
low-stock auto-suggest, LLM summary, PWA/offline.

## Non-goals (for now)
- Multi-user / accounts / sharing.
- Live store-price scraping or integrations (prices are manually entered).
- Barcode scanning, payments, loyalty cards.
