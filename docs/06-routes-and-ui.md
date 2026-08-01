# 06 — Routes & UI (HTMX)

Server-rendered EJS. Every mutating route returns the **fragment** that HTMX
swaps, not a whole page. Full pages only on `GET` navigations.

## Page map
- `/` — dashboard: next/active trip, quick "new trip", low-stock chips (v0.2).
- `/trips` — all trips (history), totals.
- `/trips/:id` — the trip workspace (the main screen): list by category,
  budget bar, habit buckets, store comparison.
- `/history` — spend analytics + charts (`dataviz`).
- `/stores/prices` — record item prices per store.
- `/recipes`, `/inventory` — `[v0.2]`.

## Routes (Express)

### Trips
```
GET    /                      -> full page (dashboard)
GET    /trips                 -> full page (list)
POST   /trips                 -> create; redirect to /trips/:id
GET    /trips/:id             -> full page (workspace)
PATCH  /trips/:id             -> update name/dates/budget/status -> partial (header)
DELETE /trips/:id             -> remove; redirect /trips
```

### List items (all return partials)
```
POST   /trips/:id/items                 body: item name/id, category, est
       -> swap: the category group + budget bar (OOB swap)
PATCH  /trips/:id/items/:lineId         body: bought, actual, qty
       -> swap: the line + budget bar (OOB)
DELETE /trips/:id/items/:lineId
       -> swap: remove line + budget bar (OOB)
GET    /trips/:id/items/suggest?q=oat   -> type-ahead <ul> from item catalog
```

### Habit buckets (partials)
```
GET    /trips/:id/insights/regulars     -> list + "add all" button
GET    /trips/:id/insights/new          -> new-this-list list
GET    /trips/:id/insights/forgotten    -> often-forgotten list
POST   /trips/:id/insights/add-regulars -> bulk add -> swap list + budget bar
```

### Store prices & comparison
```
GET    /stores/prices                    -> full page
POST   /stores/prices                    body: item, store, price -> partial row
GET    /trips/:id/compare                -> partial: per-store basket totals table
```

### Health / ops
```
GET    /healthz   -> 200 {ok:true}   (Render health check; no DB dependency)
```

### v0.2
```
GET/POST /recipes ...          -> catalog + editor
GET/POST /inventory ...        -> table + adjust
POST   /meals/log              body: recipe_id|free_text -> decrement inventory -> partial
GET    /trips/:id/explain      -> LLM summary (only if ENABLE_LLM=true)
```

## HTMX conventions
- Use `hx-post`/`hx-patch`/`hx-delete` with `hx-target` + `hx-swap`.
- Budget bar updates via **out-of-band swap** (`hx-swap-oob="true"`) so any
  mutation refreshes it without extra requests.
- Type-ahead: `hx-get=".../suggest" hx-trigger="keyup changed delay:200ms"`.
- Confirmations for destructive actions: `hx-confirm="Remove this item?"`.
- Return `4xx` + a small error partial on validation failure; don't throw HTML
  500s at the user.

## UI shape (mobile-first)
- Single column. Sticky **budget bar** at top of the trip workspace: `R{spent}
  / R{budget}` with a fill bar that goes amber near budget, red over.
- Categories as collapsible sections in the seed's category order.
- Each line: checkbox (bought), name, qty, est/actual, price. Tap checkbox →
  strike-through + subtotal update.
- Habit buckets as dismissible cards above the list when a trip is near its
  `shop_date`.
- Keep tap targets ≥ 44px; this is used one-handed in a shop.
