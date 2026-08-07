# 02 — Data model

Postgres (Neon in production, PGlite in tests). All access behind
`src/db/repo.js` — the rule that kept the SQLite→Postgres migration contained.
Money stored as **integer cents** (ZAR × 100) to avoid float drift; render as
`R{value/100}`.

## Schema (`src/db/schema.sql`)

```sql
-- Master catalog of grocery items (deduped across all trips). Drives type-ahead + habits.
CREATE TABLE item (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  category_key  TEXT NOT NULL,              -- FK -> category.key
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE category (
  key    TEXT PRIMARY KEY,                  -- 'produce', 'meat_seafood', ...
  label  TEXT NOT NULL,                     -- 'Fruits and Veggies'
  sort   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE store (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE                -- 'Checkers', 'Spar', 'Pick n Pay'
);

-- A planned shop.
CREATE TABLE trip (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,               -- quirky name
  start_date   TEXT,                        -- ISO 'YYYY-MM-DD' (period start)
  end_date     TEXT,                        -- period end ("last until")
  shop_date    TEXT,                        -- planned day you go shopping
  budget_cents INTEGER,                     -- nullable
  status       TEXT NOT NULL DEFAULT 'planning', -- planning|shopping|done
  target_store_id INTEGER,                  -- optional default store, FK store.id
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A line on a trip's list.
CREATE TABLE trip_item (
  id            INTEGER PRIMARY KEY,
  trip_id       INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES item(id),
  category_key  TEXT NOT NULL,              -- denormalised (an item can be recategorised per trip)
  qty           REAL NOT NULL DEFAULT 1,
  est_cents     INTEGER,                    -- estimate
  actual_cents  INTEGER,                    -- what it actually cost
  bought        INTEGER NOT NULL DEFAULT 0, -- 0/1  (◦ / ✓)
  position      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(trip_id, item_id)
);

-- A price seen for an item at a store on a date (historic, manual).
CREATE TABLE store_price (
  id           INTEGER PRIMARY KEY,
  item_id      INTEGER NOT NULL REFERENCES item(id),
  store_id     INTEGER NOT NULL REFERENCES store(id),
  price_cents  INTEGER NOT NULL,
  seen_date    TEXT NOT NULL DEFAULT (date('now')),
  UNIQUE(item_id, store_id, seen_date)
);

-- Recipes and their ingredients.
CREATE TABLE recipe (
  id    INTEGER PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);
CREATE TABLE recipe_ingredient (
  recipe_id  INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES item(id),
  qty        REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (recipe_id, item_id)
);

-- Meal plan cells on a trip's period grid.
CREATE TABLE meal_plan (
  id          INTEGER PRIMARY KEY,
  trip_id     INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,                -- 'YYYY-MM-DD'
  slot        TEXT NOT NULL,               -- breakfast|lunch|lunch2|dinner|dessert
  recipe_id   INTEGER REFERENCES recipe(id),
  free_text   TEXT                         -- when it's not a catalogued recipe
);

-- What you currently have at home.
CREATE TABLE inventory (
  item_id        INTEGER PRIMARY KEY REFERENCES item(id),
  qty_on_hand    REAL NOT NULL DEFAULT 0,
  unit           TEXT,
  low_threshold  REAL NOT NULL DEFAULT 1,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A meal you logged as eaten -> triggers inventory decrement.
CREATE TABLE meal_log (
  id          INTEGER PRIMARY KEY,
  eaten_date  TEXT NOT NULL DEFAULT (date('now')),
  recipe_id   INTEGER REFERENCES recipe(id),
  free_text   TEXT
);

CREATE INDEX idx_trip_item_trip ON trip_item(trip_id);
CREATE INDEX idx_store_price_item ON store_price(item_id);
```

## Seed import (`scripts/seed.js`)

Reads `docs/seed/grocery-history.json` and:
1. Upserts `category` (13 rows) and `store` (3 rows).
2. Upserts every distinct item into `item` (name + category).
3. Inserts each trip and its `trip_item` lines (est/actual → cents, bought).
4. Inserts `recipe` + `recipe_ingredient` from `recipes_seed`, creating any
   missing catalog items.
5. Idempotent: safe to re-run (use `INSERT ... ON CONFLICT DO UPDATE`).

Run: `npm run seed`. CI runs it against a throwaway DB to prove it stays green.

## Derived queries (the "AI") — reference SQL

These live in `src/lib/insights.js`. Sketches:

**Regulars** (bought in ≥ 50% of trips):
```sql
SELECT i.name, i.category_key,
       COUNT(DISTINCT ti.trip_id) AS trips_seen,
       (SELECT COUNT(*) FROM trip) AS total_trips
FROM trip_item ti JOIN item i ON i.id = ti.item_id
WHERE ti.bought = 1
GROUP BY ti.item_id
HAVING trips_seen * 1.0 / total_trips >= 0.5
ORDER BY trips_seen DESC;
```

**Often forgotten** (frequent historically, absent from trip :id):
```sql
SELECT i.name, COUNT(DISTINCT ti.trip_id) AS trips_seen
FROM trip_item ti JOIN item i ON i.id = ti.item_id
WHERE ti.trip_id <> :id
GROUP BY ti.item_id
HAVING trips_seen >= 3
   AND i.id NOT IN (SELECT item_id FROM trip_item WHERE trip_id = :id)
ORDER BY trips_seen DESC;
```

**Basket total per store** (for trip :id):
```sql
-- For each line, take the latest recorded price at each store; sum per store.
-- Lines with no price at a store are flagged 'unpriced' in the UI, not zeroed.
```

**Category budget baseline** (historical avg actual per category):
```sql
SELECT category_key, AVG(trip_total) FROM (
  SELECT trip_id, category_key, SUM(COALESCE(actual_cents, est_cents, 0)) AS trip_total
  FROM trip_item GROUP BY trip_id, category_key
) GROUP BY category_key;
```

From your seed, expected top regulars: **Eggs, Oats, Chicken breasts, Noodles,
Spinach, Tomatoes, Bell peppers, Chickpeas, Tuna** — those recur across almost
every trip and are what the app should proactively suggest.
