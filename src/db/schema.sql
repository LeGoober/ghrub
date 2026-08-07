-- ghrub schema — PostgreSQL (Neon in production, PGlite in tests).
--
-- Ported from SQLite in the Neon migration. Two deliberate carry-overs from the
-- SQLite original, both to keep the app layer unchanged:
--   * dates and timestamps stay TEXT ('YYYY-MM-DD' / 'YYYY-MM-DD HH24:MI:SS'),
--     because COALESCE(shop_date, start_date, created_at) sorts trips by mixing
--     a date and a timestamp in one expression. Real date/timestamptz columns
--     cannot be COALESCEd together without casts at every call site.
--   * `bought` stays INTEGER 0/1 rather than BOOLEAN, because SUM(bought) is
--     how the budget and habit queries count purchases.
-- Money is always integer cents — never floats.

CREATE TABLE category (
  key    TEXT PRIMARY KEY,                  -- 'produce', 'meat_seafood', ...
  label  TEXT NOT NULL,                     -- 'Fruits and Veggies'
  sort   INTEGER NOT NULL DEFAULT 0
);

-- Master catalog of grocery items (deduped across all trips). Drives type-ahead + habits.
CREATE TABLE item (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name          TEXT NOT NULL,              -- unique case-insensitively, see index below
  category_key  TEXT NOT NULL,              -- FK -> category.key
  created_at    TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- SQLite got case-insensitive uniqueness from `COLLATE NOCASE` on the column.
-- Postgres has no such collation, so uniqueness lives on the expression and the
-- repo's ON CONFLICT (lower(name)) infers this index. 'Milk' and 'milk' remain
-- one catalog entry.
CREATE UNIQUE INDEX idx_item_name_lower ON item (lower(name));

CREATE TABLE store (
  id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE                -- 'Checkers', 'Spar', 'Pick n Pay'
);

-- A planned shop.
CREATE TABLE trip (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name         TEXT NOT NULL,               -- quirky name
  start_date   TEXT,                        -- ISO 'YYYY-MM-DD' (period start)
  end_date     TEXT,                        -- period end ("last until")
  shop_date    TEXT,                        -- planned day you go shopping
  budget_cents INTEGER,                     -- nullable
  status       TEXT NOT NULL DEFAULT 'planning', -- planning|shopping|done
  target_store_id INTEGER,                  -- optional default store, FK store.id
  notes        TEXT,
  created_at   TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- A line on a trip's list.
CREATE TABLE trip_item (
  id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id       INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  item_id       INTEGER NOT NULL REFERENCES item(id),
  category_key  TEXT NOT NULL,              -- denormalised (an item can be recategorised per trip)
  qty           DOUBLE PRECISION NOT NULL DEFAULT 1,
  est_cents     INTEGER,                    -- estimate
  actual_cents  INTEGER,                    -- what it actually cost
  bought        INTEGER NOT NULL DEFAULT 0, -- 0/1  (◦ / ✓)
  position      INTEGER NOT NULL DEFAULT 0,
  UNIQUE(trip_id, item_id)
);

-- A price seen for an item at a store on a date (historic, manual).
CREATE TABLE store_price (
  id           INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  item_id      INTEGER NOT NULL REFERENCES item(id),
  store_id     INTEGER NOT NULL REFERENCES store(id),
  price_cents  INTEGER NOT NULL,
  seen_date    TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD'),
  UNIQUE(item_id, store_id, seen_date)
);

-- Recipes and their ingredients.
CREATE TABLE recipe (
  id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name  TEXT NOT NULL UNIQUE
);
CREATE TABLE recipe_ingredient (
  recipe_id  INTEGER NOT NULL REFERENCES recipe(id) ON DELETE CASCADE,
  item_id    INTEGER NOT NULL REFERENCES item(id),
  qty        DOUBLE PRECISION NOT NULL DEFAULT 1,
  PRIMARY KEY (recipe_id, item_id)
);

-- Meal plan cells on a trip's period grid.
CREATE TABLE meal_plan (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trip_id     INTEGER NOT NULL REFERENCES trip(id) ON DELETE CASCADE,
  day         TEXT NOT NULL,               -- 'YYYY-MM-DD'
  slot        TEXT NOT NULL,               -- breakfast|lunch|lunch2|dinner|dessert
  recipe_id   INTEGER REFERENCES recipe(id),
  free_text   TEXT                         -- when it's not a catalogued recipe
);

-- What you currently have at home.
CREATE TABLE inventory (
  item_id        INTEGER PRIMARY KEY REFERENCES item(id),
  qty_on_hand    DOUBLE PRECISION NOT NULL DEFAULT 0,
  unit           TEXT,
  low_threshold  DOUBLE PRECISION NOT NULL DEFAULT 1,
  updated_at     TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);

-- A meal you logged as eaten -> triggers inventory decrement.
CREATE TABLE meal_log (
  id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  eaten_date  TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD'),
  recipe_id   INTEGER REFERENCES recipe(id),
  free_text   TEXT
);

CREATE INDEX idx_trip_item_trip ON trip_item(trip_id);
CREATE INDEX idx_store_price_item ON store_price(item_id);
