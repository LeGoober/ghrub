import Database from 'better-sqlite3';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');
const DEFAULT_DB_PATH = './data/ghrub.db';

const TRIP_FIELDS = [
  'name',
  'start_date',
  'end_date',
  'shop_date',
  'budget_cents',
  'status',
  'target_store_id',
  'notes',
];

const TRIP_ITEM_FIELDS = ['category_key', 'qty', 'est_cents', 'actual_cents', 'bought'];

/**
 * Create the repository: open (creating if needed) the SQLite database, apply
 * the migration (schema.sql) when tables are missing, and return a thin
 * data-access object. ALL database access in the app goes through here so a
 * future Postgres swap stays contained (see docs/05-agent-runbook.md).
 *
 * Money columns are integer cents — never floats.
 *
 * @param {string} [dbPath] SQLite file path. Defaults to
 *   process.env.DATABASE_PATH or ./data/ghrub.db; ':memory:' is supported for tests.
 */
export function createDatabase(dbPath = process.env.DATABASE_PATH || DEFAULT_DB_PATH) {
  if (dbPath !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON'); // ON DELETE CASCADE depends on this
  migrate(db);

  return {
    close: () => db.close(),

    /** Wrap a function in a transaction (used by the seed importer). */
    transaction(fn) {
      return db.transaction(fn);
    },

    /** Row count for a known table (internal helpers only — never user input). */
    count(table) {
      return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    },

    // ---- catalog: categories, stores, items ----

    listCategories() {
      return db.prepare('SELECT * FROM category ORDER BY sort, label').all();
    },

    upsertCategory(key, label, sort = 0) {
      db.prepare(
        `INSERT INTO category (key, label, sort) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET label = excluded.label, sort = excluded.sort`
      ).run(key, label, sort);
      return db.prepare('SELECT * FROM category WHERE key = ?').get(key);
    },

    listStores() {
      return db.prepare('SELECT * FROM store ORDER BY name').all();
    },

    getOrCreateStore(name) {
      db.prepare('INSERT INTO store (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
      return db.prepare('SELECT * FROM store WHERE name = ?').get(name);
    },

    getOrCreateItem(name, categoryKey = 'pantry') {
      const trimmed = String(name).trim();
      db.prepare(
        `INSERT INTO item (name, category_key) VALUES (?, ?)
         ON CONFLICT(name) DO UPDATE SET category_key = excluded.category_key`
      ).run(trimmed, categoryKey);
      return db.prepare('SELECT * FROM item WHERE name = ?').get(trimmed);
    },

    /** Type-ahead against the item catalog. */
    searchItems(q, limit = 8) {
      const like = `%${q}%`;
      return db
        .prepare('SELECT * FROM item WHERE name LIKE ? ORDER BY name LIMIT ?')
        .all(like, limit);
    },

    // ---- trips ----

    listTrips() {
      return db
        .prepare(
          `SELECT t.*, s.name AS target_store_name,
                  (SELECT COUNT(*) FROM trip_item WHERE trip_id = t.id) AS item_count
           FROM trip t LEFT JOIN store s ON s.id = t.target_store_id
           ORDER BY COALESCE(t.shop_date, t.start_date, t.created_at) DESC, t.id DESC`
        )
        .all();
    },

    getTrip(id) {
      return db
        .prepare(
          `SELECT t.*, s.name AS target_store_name,
                  (SELECT COUNT(*) FROM trip_item WHERE trip_id = t.id) AS item_count
           FROM trip t LEFT JOIN store s ON s.id = t.target_store_id
           WHERE t.id = ?`
        )
        .get(id);
    },

    createTrip({
      name,
      start_date = null,
      end_date = null,
      shop_date = null,
      budget_cents = null,
      status = 'planning',
      target_store_id = null,
      notes = null,
    }) {
      const info = db
        .prepare(
          `INSERT INTO trip (name, start_date, end_date, shop_date, budget_cents, status, target_store_id, notes)
           VALUES (@name, @start_date, @end_date, @shop_date, @budget_cents, @status, @target_store_id, @notes)`
        )
        .run({
          name,
          start_date,
          end_date,
          shop_date,
          budget_cents,
          status,
          target_store_id,
          notes,
        });
      return this.getTrip(info.lastInsertRowid);
    },

    /** Idempotent upsert keyed on the (non-unique) name — used by the seed. */
    upsertTripByName(fields) {
      const existing = db.prepare('SELECT id FROM trip WHERE name = ?').get(fields.name);
      if (existing) {
        this.updateTrip(existing.id, fields);
        return existing.id;
      }
      return this.createTrip(fields).id;
    },

    updateTrip(id, fields) {
      const sets = [];
      const params = { id };
      for (const key of TRIP_FIELDS) {
        if (key in fields) {
          sets.push(`${key} = @${key}`);
          params[key] = fields[key];
        }
      }
      if (sets.length) {
        db.prepare(`UPDATE trip SET ${sets.join(', ')} WHERE id = @id`).run(params);
      }
      return this.getTrip(id);
    },

    deleteTrip(id) {
      db.prepare('DELETE FROM trip WHERE id = ?').run(id);
    },

    // ---- trip items ----

    getTripItem(id) {
      return db
        .prepare(
          `SELECT ti.*, i.name AS item_name, c.label AS category_label
           FROM trip_item ti
           JOIN item i ON i.id = ti.item_id
           JOIN category c ON c.key = ti.category_key
           WHERE ti.id = ?`
        )
        .get(id);
    },

    getTripItems(tripId) {
      return db
        .prepare(
          `SELECT ti.*, i.name AS item_name, c.label AS category_label
           FROM trip_item ti
           JOIN item i ON i.id = ti.item_id
           JOIN category c ON c.key = ti.category_key
           WHERE ti.trip_id = ?
           ORDER BY c.sort, ti.position, ti.id`
        )
        .all(tripId);
    },

    addTripItem(
      tripId,
      {
        itemId = null,
        itemName = null,
        categoryKey = null,
        estCents = null,
        actualCents = null,
        bought = 0,
        qty = 1,
        position = null,
      }
    ) {
      let item = null;
      if (itemId) item = db.prepare('SELECT * FROM item WHERE id = ?').get(itemId);
      else if (itemName) item = this.getOrCreateItem(itemName, categoryKey);
      if (!item) throw new Error('addTripItem: no item resolved');
      const resolvedCategory = categoryKey || item.category_key;
      const pos =
        position ??
        db
          .prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM trip_item WHERE trip_id = ?')
          .get(tripId).p;
      const info = db
        .prepare(
          `INSERT INTO trip_item (trip_id, item_id, category_key, qty, est_cents, actual_cents, bought, position)
           VALUES (@trip_id, @item_id, @category_key, @qty, @est_cents, @actual_cents, @bought, @position)
           ON CONFLICT(trip_id, item_id) DO UPDATE SET
             category_key   = excluded.category_key,
             qty            = excluded.qty,
             est_cents      = excluded.est_cents,
             actual_cents   = excluded.actual_cents,
             bought         = excluded.bought,
             position       = excluded.position`
        )
        .run({
          trip_id: tripId,
          item_id: item.id,
          category_key: resolvedCategory,
          qty,
          est_cents: estCents,
          actual_cents: actualCents,
          bought,
          position: pos,
        });
      return this.getTripItem(info.lastInsertRowid);
    },

    updateTripItem(id, fields) {
      const sets = [];
      const params = { id };
      for (const key of TRIP_ITEM_FIELDS) {
        if (key in fields) {
          sets.push(`${key} = @${key}`);
          params[key] = fields[key];
        }
      }
      if (sets.length) {
        db.prepare(`UPDATE trip_item SET ${sets.join(', ')} WHERE id = @id`).run(params);
      }
      return this.getTripItem(id);
    },

    deleteTripItem(id) {
      db.prepare('DELETE FROM trip_item WHERE id = ?').run(id);
    },

    /**
     * Live budget numbers for the sticky bar. Subtotal blends actual for bought
     * lines and estimate otherwise (COALESCE(actual_cents, est_cents, 0)).
     */
    budgetForTrip(tripId) {
      const trip = db.prepare('SELECT budget_cents FROM trip WHERE id = ?').get(tripId);
      const byCategory = db
        .prepare(
          `SELECT c.key AS category_key, c.label AS category_label,
                  COUNT(*) AS line_count,
                  COALESCE(SUM(CASE WHEN bought = 1 THEN 1 ELSE 0 END), 0) AS bought_count,
                  COALESCE(SUM(COALESCE(actual_cents, est_cents, 0)), 0) AS subtotal_cents
           FROM trip_item ti
           JOIN category c ON c.key = ti.category_key
           WHERE ti.trip_id = ?
           GROUP BY c.key, c.label
           ORDER BY c.sort, c.label`
        )
        .all(tripId);
      const subtotalCents = byCategory.reduce((sum, r) => sum + r.subtotal_cents, 0);
      const lineCount = byCategory.reduce((sum, r) => sum + r.line_count, 0);
      const boughtCount = byCategory.reduce((sum, r) => sum + r.bought_count, 0);
      const budgetCents = trip?.budget_cents ?? null;
      const pct = budgetCents ? subtotalCents / budgetCents : null;
      const state =
        budgetCents == null ? 'unbudgeted' : pct >= 1 ? 'over' : pct >= 0.8 ? 'near' : 'ok';
      return { budgetCents, subtotalCents, pct, state, lineCount, boughtCount, byCategory };
    },

    // ---- habit intelligence (M2) ----
    // These are the raw shapes only. The thresholds, ratios and cadence maths
    // live in src/lib/insights.js — SQL stays here so the Postgres swap stays
    // contained (docs/05 hard rule).

    /**
     * How often each catalog item recurs across trips — both counts in one
     * pass: how many trips *listed* it, and how many actually *bought* it.
     * Callers pick the numerator (see src/lib/insights.js).
     *
     * `excludeTripId` drops a trip from the counts AND from total_trips, so
     * opening a fresh trip cannot dilute its own suggestions with itself.
     *
     * @param {number|null} excludeTripId
     */
    itemFrequency(excludeTripId = null) {
      return db
        .prepare(
          `SELECT i.id AS item_id, i.name, ti.category_key, c.label AS category_label,
                  COUNT(DISTINCT ti.trip_id) AS trips_listed,
                  COUNT(DISTINCT CASE WHEN ti.bought = 1 THEN ti.trip_id END) AS trips_bought,
                  (SELECT COUNT(*) FROM trip WHERE id IS NOT @exclude) AS total_trips
           FROM trip_item ti
           JOIN item i ON i.id = ti.item_id
           JOIN category c ON c.key = ti.category_key
           WHERE ti.trip_id IS NOT @exclude
           GROUP BY ti.item_id
           ORDER BY trips_listed DESC, trips_bought DESC, i.name`
        )
        .all({ exclude: excludeTripId });
    },

    /** Item ids already on a trip — used to filter suggestions. */
    itemIdsOnTrip(tripId) {
      return db
        .prepare('SELECT item_id FROM trip_item WHERE trip_id = ?')
        .all(tripId)
        .map((r) => r.item_id);
    },

    /** Lines on this trip whose item has never appeared on any other trip. */
    itemsFirstSeenOnTrip(tripId) {
      return db
        .prepare(
          `SELECT ti.id, ti.item_id, i.name, ti.category_key, c.label AS category_label
           FROM trip_item ti
           JOIN item i ON i.id = ti.item_id
           JOIN category c ON c.key = ti.category_key
           WHERE ti.trip_id = @tripId
             AND NOT EXISTS (
               SELECT 1 FROM trip_item o
               WHERE o.item_id = ti.item_id AND o.trip_id <> @tripId
             )
           ORDER BY c.sort, i.name`
        )
        .all({ tripId });
    },

    /** One row per trip: dates, budget and blended spend. Oldest first. */
    tripSpendSummaries() {
      return db
        .prepare(
          `SELECT t.id, t.name, t.start_date, t.end_date, t.shop_date, t.status,
                  t.budget_cents,
                  COUNT(ti.id) AS line_count,
                  COALESCE(SUM(ti.bought), 0) AS bought_count,
                  COALESCE(SUM(COALESCE(ti.actual_cents, ti.est_cents, 0)), 0) AS total_cents,
                  COALESCE(t.shop_date, t.start_date, t.created_at) AS effective_date
           FROM trip t
           LEFT JOIN trip_item ti ON ti.trip_id = t.id
           GROUP BY t.id
           ORDER BY effective_date, t.id`
        )
        .all();
    },

    /** Average spend per category per trip — the budgeting baseline (docs/02). */
    categorySpendAverages() {
      return db
        .prepare(
          `SELECT c.key AS category_key, c.label AS category_label,
                  COUNT(*) AS trips_with_category,
                  CAST(ROUND(AVG(x.trip_total)) AS INTEGER) AS avg_cents,
                  SUM(x.trip_total) AS total_cents
           FROM (
             SELECT trip_id, category_key,
                    SUM(COALESCE(actual_cents, est_cents, 0)) AS trip_total
             FROM trip_item
             GROUP BY trip_id, category_key
           ) x
           JOIN category c ON c.key = x.category_key
           GROUP BY c.key, c.label
           ORDER BY avg_cents DESC, c.label`
        )
        .all();
    },

    // ---- recipes (seeded; used from M2 on) ----

    upsertRecipe(name) {
      db.prepare('INSERT INTO recipe (name) VALUES (?) ON CONFLICT(name) DO NOTHING').run(name);
      return db.prepare('SELECT id FROM recipe WHERE name = ?').get(name).id;
    },

    upsertRecipeIngredient(recipeId, itemId, qty = 1) {
      db.prepare(
        `INSERT INTO recipe_ingredient (recipe_id, item_id, qty) VALUES (?, ?, ?)
         ON CONFLICT(recipe_id, item_id) DO UPDATE SET qty = excluded.qty`
      ).run(recipeId, itemId, qty);
    },
  };
}

/** Apply schema.sql only when the tables are missing (idempotent migration). */
function migrate(db) {
  const hasTripTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'trip'")
    .get();
  if (!hasTripTable) {
    db.exec(readFileSync(SCHEMA_PATH, 'utf8'));
  }
}
