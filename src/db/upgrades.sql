-- ghrub upgrades — additive changes to a database that already exists.
--
-- schema.sql only runs against an empty database (see migrate() in repo.js), so
-- anything added after the first deploy lives here instead. Every statement
-- must be idempotent: this file runs on every boot, against fresh and
-- long-lived databases alike.

-- What a till prints for a product -> the catalog item it really is.
-- Learnt from the receipt review form: correct "CHKN BRST FLLT" to "Chicken
-- breasts" once, and every later slip reads it right.
CREATE TABLE IF NOT EXISTS item_alias (
  alias       TEXT PRIMARY KEY,            -- normalised slip text (see normaliseName)
  item_id     INTEGER NOT NULL REFERENCES item(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT to_char(now(), 'YYYY-MM-DD HH24:MI:SS')
);
