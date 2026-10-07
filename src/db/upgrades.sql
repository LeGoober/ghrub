-- ghrub upgrades — additive changes to a database that already exists.
--
-- schema.sql only runs against an empty database (see migrate() in repo.js), so
-- anything added after the first deploy lives here instead. Every statement
-- must be idempotent: this file runs on every boot, against fresh and
-- long-lived databases alike.

-- Reference data every database needs before a single item can be filed.
-- Production's Neon database was created empty and never seeded, so the
-- category list was blank and every "Add item" failed the foreign key on
-- item.category_key. DO NOTHING, so a label or order you have edited is never
-- overwritten. Mirrors docs/seed/grocery-history.json.
INSERT INTO category (key, label, sort) VALUES
  ('produce', 'Fruits and Veggies', 0),
  ('meat_seafood', 'Meat and Seafood', 1),
  ('bread_grains', 'Bread and Grains', 2),
  ('dairy_eggs', 'Dairy and Eggs', 3),
  ('spices_condiments', 'Spices and Condiments', 4),
  ('pantry', 'Pantry Staples', 5),
  ('canned', 'Canned goods', 6),
  ('frozen', 'Frozen goods', 7),
  ('toiletries', 'Toiletries', 8),
  ('household', 'Household items', 9),
  ('supplements', 'Supplements and Health', 10),
  ('snacks', 'Snacks', 11),
  ('water', 'Water and Hydration', 12)
ON CONFLICT (key) DO NOTHING;

INSERT INTO store (name) VALUES ('Checkers'), ('Spar'), ('Pick n Pay')
ON CONFLICT (name) DO NOTHING;

-- What a till prints for a product -> the catalog item it really is.
-- Learnt from the receipt review form: correct "CHKN BRST FLLT" to "Chicken
-- breasts" once, and every later slip reads it right.
CREATE TABLE IF NOT EXISTS item_alias (
  alias       TEXT PRIMARY KEY,            -- normalised slip text (see normaliseName)
  item_id     INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
