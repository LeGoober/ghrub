import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

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
 * Queries issued inside db.transaction() must run on the transaction's own
 * connection, not an arbitrary pool member, or they land outside the BEGIN.
 * AsyncLocalStorage scopes that connection to the async call tree, so two
 * concurrent requests cannot leak queries into each other's transaction.
 */
const txConnection = new AsyncLocalStorage();

/**
 * Rewrite the readable `@name` placeholders used in this file into the
 * positional `$1` form the wire protocol requires, collecting values in order.
 * Repeated names bind once.
 */
function toPositional(text, params) {
  const values = [];
  const seen = new Map();
  const rewritten = text.replace(/@([a-z_][a-z0-9_]*)/gi, (_match, name) => {
    if (!seen.has(name)) {
      values.push(params[name]);
      seen.set(name, values.length);
    }
    return `$${seen.get(name)}`;
  });
  return { text: rewritten, values };
}

/** Postgres over a real server (Neon in production). */
function poolDriver(connectionString) {
  // Honour what the URL asks for instead of forcing TLS either way: Neon's URL
  // carries sslmode=require, while a local or CI Postgres usually serves no TLS
  // at all and refuses the handshake. Verification stays on when TLS is used —
  // Neon's certificate comes from a public CA, and this connection carries the
  // entire grocery history.
  const wantsSsl = /[?&]sslmode=(require|verify-ca|verify-full)/.test(connectionString);
  const pool = new pg.Pool({
    connectionString,
    ssl: wantsSsl ? { rejectUnauthorized: true } : false,
    max: 5,
  });
  return {
    query: (text, values) => pool.query(text, values),
    withConnection: async (fn) => {
      const client = await pool.connect();
      try {
        return await fn({
          query: (text, values) => client.query(text, values),
          exec: (sql) => client.query(sql),
        });
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}

let templatePromise = null;

/**
 * A pre-migrated PGlite data directory, reused for every in-memory database.
 *
 * Booting PGlite from scratch runs initdb and costs ~4s. Paying that per test
 * blows vitest's timeout; paying it per worker still costs a minute across the
 * suite, since vitest gives each test file its own process. So the dump is
 * cached on disk, keyed by a hash of schema.sql: the first process to need it
 * builds it, every later one restores in ~0.5s, already migrated. Editing the
 * schema changes the key and the template rebuilds on its own.
 */
function memoryTemplate(PGlite) {
  templatePromise ??= (async () => {
    const schemaSql = readFileSync(SCHEMA_PATH, 'utf8');
    const key = createHash('sha256').update(schemaSql).digest('hex').slice(0, 16);
    const cachePath = path.join(tmpdir(), `ghrub-pglite-template-${key}.tar`);

    if (existsSync(cachePath)) {
      return new File([readFileSync(cachePath)], 'template.tar');
    }

    const seed = new PGlite();
    await seed.waitReady;
    await seed.exec(schemaSql);
    const dump = await seed.dumpDataDir('none'); // uncompressed: this is a scratch file
    await seed.close();

    // Write via a process-unique name and rename, so concurrent workers cannot
    // read a half-written template.
    const buffer = Buffer.from(await dump.arrayBuffer());
    const staging = `${cachePath}.${process.pid}.tmp`;
    try {
      writeFileSync(staging, buffer);
      renameSync(staging, cachePath);
    } catch {
      // A cache we cannot write is not worth failing a test run over.
    }
    return new File([buffer], 'template.tar');
  })();
  return templatePromise;
}

/**
 * Postgres compiled to WASM, running in-process. Used by the test suite, which
 * wants a throwaway database per test with no server and no network — the role
 * `:memory:` played under SQLite. Imported dynamically because it is a
 * devDependency and absent from the production image.
 */
async function memoryDriver() {
  const { PGlite } = await import('@electric-sql/pglite');
  const lite = new PGlite({ loadDataDir: await memoryTemplate(PGlite) });
  await lite.waitReady;
  return {
    query: (text, values) => lite.query(text, values),
    withConnection: (fn) =>
      fn({
        query: (text, values) => lite.query(text, values),
        // PGlite's query() takes a single statement; exec() is what runs the
        // whole schema file in one go.
        exec: (sql) => lite.exec(sql),
      }),
    close: () => lite.close(),
  };
}

/**
 * Create the repository: connect to Postgres, apply the migration (schema.sql)
 * when tables are missing, and return a thin data-access object. ALL database
 * access in the app goes through here so the storage engine stays swappable
 * (see docs/05-agent-runbook.md) — that rule is what made the Neon migration
 * a contained change.
 *
 * Every method is async. Money columns are integer cents — never floats.
 *
 * @param {string} [url] Postgres connection string. Defaults to
 *   process.env.DATABASE_URL; ':memory:' selects PGlite for tests.
 */
export async function createDatabase(url = process.env.DATABASE_URL) {
  if (!url) {
    throw new Error(
      'createDatabase: no connection string. Set DATABASE_URL (or pass ":memory:" in tests).'
    );
  }
  const driver = url === ':memory:' ? await memoryDriver() : poolDriver(url);
  await migrate(driver);

  /** The transaction's connection when inside one, the pool otherwise. */
  const conn = () => txConnection.getStore() ?? driver;

  const all = async (text, params) => {
    const { text: sql, values } = Array.isArray(params)
      ? { text, values: params }
      : toPositional(text, params ?? {});
    const result = await conn().query(sql, values);
    return result.rows;
  };
  const get = async (text, params) => (await all(text, params))[0];

  return {
    close: () => driver.close(),

    /**
     * Run fn inside a transaction. Nested calls join the open transaction
     * rather than opening a second one.
     */
    async transaction(fn) {
      if (txConnection.getStore()) return fn();
      return driver.withConnection(async (client) => {
        await client.query('BEGIN');
        try {
          const result = await txConnection.run(client, fn);
          await client.query('COMMIT');
          return result;
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        }
      });
    },

    /** Row count for a known table (internal helpers only — never user input). */
    async count(table) {
      return (await get(`SELECT COUNT(*)::int AS n FROM ${table}`)).n;
    },

    // ---- catalog: categories, stores, items ----

    listCategories() {
      return all('SELECT * FROM category ORDER BY sort, label');
    },

    upsertCategory(key, label, sort = 0) {
      return get(
        `INSERT INTO category (key, label, sort) VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE SET label = excluded.label, sort = excluded.sort
         RETURNING *`,
        [key, label, sort]
      );
    },

    listStores() {
      return all('SELECT * FROM store ORDER BY name');
    },

    getOrCreateStore(name) {
      // The no-op DO UPDATE (rather than DO NOTHING) is what makes RETURNING
      // yield the existing row on conflict, keeping this a single round trip.
      return get(
        `INSERT INTO store (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = excluded.name
         RETURNING *`,
        [name]
      );
    },

    getOrCreateItem(name, categoryKey = 'pantry') {
      return get(
        `INSERT INTO item (name, category_key) VALUES ($1, $2)
         ON CONFLICT (lower(name)) DO UPDATE SET category_key = excluded.category_key
         RETURNING *`,
        [String(name).trim(), categoryKey]
      );
    },

    /** Type-ahead against the item catalog. ILIKE keeps SQLite's LIKE case-insensitivity. */
    searchItems(q, limit = 8) {
      return all('SELECT * FROM item WHERE name ILIKE $1 ORDER BY name LIMIT $2', [
        `%${q}%`,
        limit,
      ]);
    },

    // ---- trips ----

    listTrips() {
      return all(
        `SELECT t.*, s.name AS target_store_name,
                (SELECT COUNT(*) FROM trip_item WHERE trip_id = t.id)::int AS item_count
         FROM trip t LEFT JOIN store s ON s.id = t.target_store_id
         ORDER BY COALESCE(t.shop_date, t.start_date, t.created_at) DESC, t.id DESC`
      );
    },

    getTrip(id) {
      return get(
        `SELECT t.*, s.name AS target_store_name,
                (SELECT COUNT(*) FROM trip_item WHERE trip_id = t.id)::int AS item_count
         FROM trip t LEFT JOIN store s ON s.id = t.target_store_id
         WHERE t.id = $1`,
        [id]
      );
    },

    async createTrip({
      name,
      start_date = null,
      end_date = null,
      shop_date = null,
      budget_cents = null,
      status = 'planning',
      target_store_id = null,
      notes = null,
    }) {
      const row = await get(
        `INSERT INTO trip (name, start_date, end_date, shop_date, budget_cents, status, target_store_id, notes)
         VALUES (@name, @start_date, @end_date, @shop_date, @budget_cents, @status, @target_store_id, @notes)
         RETURNING id`,
        { name, start_date, end_date, shop_date, budget_cents, status, target_store_id, notes }
      );
      return this.getTrip(row.id);
    },

    /** Idempotent upsert keyed on the (non-unique) name — used by the seed. */
    async upsertTripByName(fields) {
      const existing = await get('SELECT id FROM trip WHERE name = $1', [fields.name]);
      if (existing) {
        await this.updateTrip(existing.id, fields);
        return existing.id;
      }
      return (await this.createTrip(fields)).id;
    },

    async updateTrip(id, fields) {
      const sets = [];
      const params = { id };
      for (const key of TRIP_FIELDS) {
        if (key in fields) {
          sets.push(`${key} = @${key}`);
          params[key] = fields[key];
        }
      }
      if (sets.length) {
        await all(`UPDATE trip SET ${sets.join(', ')} WHERE id = @id`, params);
      }
      return this.getTrip(id);
    },

    async deleteTrip(id) {
      await all('DELETE FROM trip WHERE id = $1', [id]);
    },

    // ---- trip items ----

    getTripItem(id) {
      return get(
        `SELECT ti.*, i.name AS item_name, c.label AS category_label
         FROM trip_item ti
         JOIN item i ON i.id = ti.item_id
         JOIN category c ON c.key = ti.category_key
         WHERE ti.id = $1`,
        [id]
      );
    },

    getTripItems(tripId) {
      return all(
        `SELECT ti.*, i.name AS item_name, c.label AS category_label
         FROM trip_item ti
         JOIN item i ON i.id = ti.item_id
         JOIN category c ON c.key = ti.category_key
         WHERE ti.trip_id = $1
         ORDER BY c.sort, ti.position, ti.id`,
        [tripId]
      );
    },

    async addTripItem(
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
      if (itemId) item = await get('SELECT * FROM item WHERE id = $1', [itemId]);
      else if (itemName) item = await this.getOrCreateItem(itemName, categoryKey);
      if (!item) throw new Error('addTripItem: no item resolved');
      const resolvedCategory = categoryKey || item.category_key;
      const pos =
        position ??
        (
          await get(
            'SELECT COALESCE(MAX(position), 0) + 1 AS p FROM trip_item WHERE trip_id = $1',
            [tripId]
          )
        ).p;
      const row = await get(
        `INSERT INTO trip_item (trip_id, item_id, category_key, qty, est_cents, actual_cents, bought, position)
         VALUES (@trip_id, @item_id, @category_key, @qty, @est_cents, @actual_cents, @bought, @position)
         ON CONFLICT (trip_id, item_id) DO UPDATE SET
           category_key   = excluded.category_key,
           qty            = excluded.qty,
           est_cents      = excluded.est_cents,
           actual_cents   = excluded.actual_cents,
           bought         = excluded.bought,
           position       = excluded.position
         RETURNING id`,
        {
          trip_id: tripId,
          item_id: item.id,
          category_key: resolvedCategory,
          qty,
          est_cents: estCents,
          actual_cents: actualCents,
          bought,
          position: pos,
        }
      );
      return this.getTripItem(row.id);
    },

    async updateTripItem(id, fields) {
      const sets = [];
      const params = { id };
      for (const key of TRIP_ITEM_FIELDS) {
        if (key in fields) {
          sets.push(`${key} = @${key}`);
          params[key] = fields[key];
        }
      }
      if (sets.length) {
        await all(`UPDATE trip_item SET ${sets.join(', ')} WHERE id = @id`, params);
      }
      return this.getTripItem(id);
    },

    async deleteTripItem(id) {
      await all('DELETE FROM trip_item WHERE id = $1', [id]);
    },

    /**
     * Live budget numbers for the sticky bar. Subtotal blends actual for bought
     * lines and estimate otherwise (COALESCE(actual_cents, est_cents, 0)).
     */
    async budgetForTrip(tripId) {
      const trip = await get('SELECT budget_cents FROM trip WHERE id = $1', [tripId]);
      // Every aggregate is cast to int: Postgres returns COUNT/SUM as bigint,
      // which node-postgres hands back as a *string*. Without the casts the
      // reduces below would concatenate digits instead of adding cents.
      const byCategory = await all(
        `SELECT c.key AS category_key, c.label AS category_label,
                COUNT(*)::int AS line_count,
                COALESCE(SUM(CASE WHEN bought = 1 THEN 1 ELSE 0 END), 0)::int AS bought_count,
                COALESCE(SUM(COALESCE(actual_cents, est_cents, 0)), 0)::int AS subtotal_cents
         FROM trip_item ti
         JOIN category c ON c.key = ti.category_key
         WHERE ti.trip_id = $1
         GROUP BY c.key, c.label
         ORDER BY c.sort, c.label`,
        [tripId]
      );
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
    // live in src/lib/insights.js — SQL stays here so the storage engine stays
    // swappable (docs/05 hard rule).

    /**
     * How often each catalog item recurs across trips — both counts in one
     * pass: how many trips *listed* it, and how many actually *bought* it.
     * Callers pick the numerator (see src/lib/insights.js).
     *
     * `excludeTripId` drops a trip from the counts AND from total_trips, so
     * opening a fresh trip cannot dilute its own suggestions with itself.
     * SQLite's null-safe `IS NOT` becomes `IS DISTINCT FROM` here, which keeps
     * a null exclusion meaning "exclude nothing".
     *
     * An item recategorised between trips has several category_key values; the
     * MIN() collapses it back to one row per item, as SQLite's bare-column
     * GROUP BY did.
     *
     * @param {number|null} excludeTripId
     */
    itemFrequency(excludeTripId = null) {
      return all(
        `SELECT i.id AS item_id, i.name,
                MIN(ti.category_key) AS category_key,
                MIN(c.label) AS category_label,
                COUNT(DISTINCT ti.trip_id)::int AS trips_listed,
                COUNT(DISTINCT CASE WHEN ti.bought = 1 THEN ti.trip_id END)::int AS trips_bought,
                (SELECT COUNT(*) FROM trip WHERE id IS DISTINCT FROM @exclude::int)::int AS total_trips
         FROM trip_item ti
         JOIN item i ON i.id = ti.item_id
         JOIN category c ON c.key = ti.category_key
         WHERE ti.trip_id IS DISTINCT FROM @exclude::int
         GROUP BY i.id
         ORDER BY trips_listed DESC, trips_bought DESC, i.name`,
        { exclude: excludeTripId }
      );
    },

    /** Item ids already on a trip — used to filter suggestions. */
    async itemIdsOnTrip(tripId) {
      const rows = await all('SELECT item_id FROM trip_item WHERE trip_id = $1', [tripId]);
      return rows.map((r) => r.item_id);
    },

    /** Lines on this trip whose item has never appeared on any other trip. */
    itemsFirstSeenOnTrip(tripId) {
      return all(
        `SELECT ti.id, ti.item_id, i.name, ti.category_key, c.label AS category_label
         FROM trip_item ti
         JOIN item i ON i.id = ti.item_id
         JOIN category c ON c.key = ti.category_key
         WHERE ti.trip_id = @tripId
           AND NOT EXISTS (
             SELECT 1 FROM trip_item o
             WHERE o.item_id = ti.item_id AND o.trip_id <> @tripId
           )
         ORDER BY c.sort, i.name`,
        { tripId }
      );
    },

    /** One row per trip: dates, budget and blended spend. Oldest first. */
    tripSpendSummaries() {
      return all(
        `SELECT t.id, t.name, t.start_date, t.end_date, t.shop_date, t.status,
                t.budget_cents,
                COUNT(ti.id)::int AS line_count,
                COALESCE(SUM(ti.bought), 0)::int AS bought_count,
                COALESCE(SUM(COALESCE(ti.actual_cents, ti.est_cents, 0)), 0)::int AS total_cents,
                COALESCE(t.shop_date, t.start_date, t.created_at) AS effective_date
         FROM trip t
         LEFT JOIN trip_item ti ON ti.trip_id = t.id
         GROUP BY t.id
         ORDER BY effective_date, t.id`
      );
    },

    /** Average spend per category per trip — the budgeting baseline (docs/02). */
    categorySpendAverages() {
      return all(
        `SELECT c.key AS category_key, c.label AS category_label,
                COUNT(*)::int AS trips_with_category,
                ROUND(AVG(x.trip_total))::int AS avg_cents,
                SUM(x.trip_total)::int AS total_cents
         FROM (
           SELECT trip_id, category_key,
                  SUM(COALESCE(actual_cents, est_cents, 0)) AS trip_total
           FROM trip_item
           GROUP BY trip_id, category_key
         ) x
         JOIN category c ON c.key = x.category_key
         GROUP BY c.key, c.label
         ORDER BY avg_cents DESC, c.label`
      );
    },

    // ---- store prices (M3) ----
    // schema.sql keys store_price on (item_id, store_id, seen_date), so the
    // table is a price *history*: recording a new price on a new day adds a row
    // rather than overwriting, and "the price" means the most recent one.

    /** Record a price. Re-recording on the same day corrects that day's entry. */
    async upsertStorePrice(itemId, storeId, priceCents, seenDate = null) {
      await all(
        `INSERT INTO store_price (item_id, store_id, price_cents, seen_date)
         VALUES (@item_id, @store_id, @price_cents,
                 COALESCE(@seen_date::text, to_char(now(), 'YYYY-MM-DD')))
         ON CONFLICT (item_id, store_id, seen_date)
           DO UPDATE SET price_cents = excluded.price_cents`,
        {
          item_id: itemId,
          store_id: storeId,
          price_cents: priceCents,
          seen_date: seenDate,
        }
      );
    },

    /**
     * The latest price for every (item, store) pair on a trip's list.
     *
     * One row per line per store that has ever been priced — lines with no
     * price at a store are simply absent, so the caller can flag them instead
     * of treating a missing price as free (docs/02).
     */
    latestPricesForTrip(tripId) {
      return all(
        `SELECT ti.id AS line_id, ti.qty, i.id AS item_id, i.name AS item_name,
                s.id AS store_id, s.name AS store_name,
                sp.price_cents, sp.seen_date
         FROM trip_item ti
         JOIN item i ON i.id = ti.item_id
         JOIN store_price sp ON sp.item_id = ti.item_id
         JOIN store s ON s.id = sp.store_id
         JOIN (
           SELECT item_id, store_id, MAX(seen_date) AS latest
           FROM store_price GROUP BY item_id, store_id
         ) newest
           ON newest.item_id = sp.item_id
          AND newest.store_id = sp.store_id
          AND newest.latest = sp.seen_date
         WHERE ti.trip_id = $1
         ORDER BY i.name, s.name`,
        [tripId]
      );
    },

    /** Latest price per store for one item — powers "remembers last price". */
    latestPricesForItem(itemId) {
      return all(
        `SELECT s.id AS store_id, s.name AS store_name, sp.price_cents, sp.seen_date
         FROM store_price sp
         JOIN store s ON s.id = sp.store_id
         JOIN (
           SELECT store_id, MAX(seen_date) AS latest
           FROM store_price WHERE item_id = @itemId GROUP BY store_id
         ) newest
           ON newest.store_id = sp.store_id AND newest.latest = sp.seen_date
         WHERE sp.item_id = @itemId
         ORDER BY s.name`,
        { itemId }
      );
    },

    /** Most recently recorded prices, newest first — the /stores/prices table. */
    listStorePrices(limit = 40) {
      return all(
        `SELECT sp.id, sp.price_cents, sp.seen_date,
                i.id AS item_id, i.name AS item_name,
                s.id AS store_id, s.name AS store_name
         FROM store_price sp
         JOIN item i ON i.id = sp.item_id
         JOIN store s ON s.id = sp.store_id
         ORDER BY sp.seen_date DESC, sp.id DESC
         LIMIT $1`,
        [limit]
      );
    },

    // ---- recipes (seeded; used from M2 on) ----

    async upsertRecipe(name) {
      const row = await get(
        `INSERT INTO recipe (name) VALUES ($1)
         ON CONFLICT (name) DO UPDATE SET name = excluded.name
         RETURNING id`,
        [name]
      );
      return row.id;
    },

    async upsertRecipeIngredient(recipeId, itemId, qty = 1) {
      await all(
        `INSERT INTO recipe_ingredient (recipe_id, item_id, qty) VALUES ($1, $2, $3)
         ON CONFLICT (recipe_id, item_id) DO UPDATE SET qty = excluded.qty`,
        [recipeId, itemId, qty]
      );
    },

    // ---- recipes, inventory and the meal loop (M4) ----

    listRecipes() {
      return all(
        `SELECT r.*,
                (SELECT COUNT(*) FROM recipe_ingredient WHERE recipe_id = r.id)::int AS ingredient_count
         FROM recipe r ORDER BY r.name`
      );
    },

    async getRecipe(id) {
      const recipe = await get('SELECT * FROM recipe WHERE id = $1', [id]);
      if (!recipe) return undefined;
      return { ...recipe, ingredients: await this.getRecipeIngredients(id) };
    },

    getRecipeIngredients(recipeId) {
      return all(
        `SELECT ri.item_id, ri.qty, i.name AS item_name, i.category_key
         FROM recipe_ingredient ri
         JOIN item i ON i.id = ri.item_id
         WHERE ri.recipe_id = $1
         ORDER BY i.name`,
        [recipeId]
      );
    },

    /** Replace a recipe's ingredient list wholesale (the editor posts the set). */
    async setRecipeIngredients(recipeId, ingredients) {
      await this.transaction(async () => {
        await all('DELETE FROM recipe_ingredient WHERE recipe_id = $1', [recipeId]);
        for (const { itemId, qty } of ingredients) {
          await this.upsertRecipeIngredient(recipeId, itemId, qty);
        }
      });
      return this.getRecipe(recipeId);
    },

    async deleteRecipe(id) {
      await all('DELETE FROM recipe WHERE id = $1', [id]);
    },

    // -- inventory --
    // Only items with an inventory row are "tracked". Everything else in the
    // catalog is simply not being counted, which is different from being at
    // zero — otherwise all 100 seeded items would report as running low.

    listInventory() {
      return all(
        `SELECT inv.*, i.name AS item_name, i.category_key, c.label AS category_label
         FROM inventory inv
         JOIN item i ON i.id = inv.item_id
         JOIN category c ON c.key = i.category_key
         ORDER BY i.name`
      );
    },

    getInventory(itemId) {
      return get('SELECT * FROM inventory WHERE item_id = $1', [itemId]);
    },

    async setInventory(itemId, { qtyOnHand = 0, unit = null, lowThreshold = 1 } = {}) {
      await all(
        `INSERT INTO inventory (item_id, qty_on_hand, unit, low_threshold, updated_at)
         VALUES (@item_id, @qty, @unit, @low, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (item_id) DO UPDATE SET
           qty_on_hand   = excluded.qty_on_hand,
           unit          = COALESCE(excluded.unit, inventory.unit),
           low_threshold = excluded.low_threshold,
           updated_at    = excluded.updated_at`,
        { item_id: itemId, qty: qtyOnHand, unit, low: lowThreshold }
      );
      return this.getInventory(itemId);
    },

    /**
     * Move stock by a delta, creating the row if the item was untracked.
     * Never goes below zero — you cannot have -2 eggs.
     */
    async adjustInventory(itemId, delta) {
      await all(
        `INSERT INTO inventory (item_id, qty_on_hand, updated_at)
         VALUES (@item_id, GREATEST(0, @delta::float8), to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
         ON CONFLICT (item_id) DO UPDATE SET
           qty_on_hand = GREATEST(0, inventory.qty_on_hand + @delta::float8),
           updated_at  = to_char(now(), 'YYYY-MM-DD HH24:MI:SS')`,
        { item_id: itemId, delta }
      );
      return this.getInventory(itemId);
    },

    /** Tracked items at or below their low-water mark. */
    lowStockItems() {
      return all(
        `SELECT inv.*, i.name AS item_name, i.category_key, c.label AS category_label
         FROM inventory inv
         JOIN item i ON i.id = inv.item_id
         JOIN category c ON c.key = i.category_key
         WHERE inv.qty_on_hand <= inv.low_threshold
         ORDER BY (inv.qty_on_hand - inv.low_threshold), i.name`
      );
    },

    // -- meal log --

    logMeal({ recipeId = null, freeText = null, eatenDate = null }) {
      return get(
        `INSERT INTO meal_log (eaten_date, recipe_id, free_text)
         VALUES (COALESCE(@eaten_date::text, to_char(now(), 'YYYY-MM-DD')), @recipe_id, @free_text)
         RETURNING *`,
        { eaten_date: eatenDate, recipe_id: recipeId, free_text: freeText }
      );
    },

    listMealLog(limit = 20) {
      return all(
        `SELECT ml.*, r.name AS recipe_name
         FROM meal_log ml
         LEFT JOIN recipe r ON r.id = ml.recipe_id
         ORDER BY ml.eaten_date DESC, ml.id DESC
         LIMIT $1`,
        [limit]
      );
    },

    // -- meal plan (the trip period grid) --

    getMealPlan(tripId) {
      return all(
        `SELECT mp.*, r.name AS recipe_name
         FROM meal_plan mp
         LEFT JOIN recipe r ON r.id = mp.recipe_id
         WHERE mp.trip_id = $1`,
        [tripId]
      );
    },

    /**
     * Set one cell of the grid. Clearing both fields removes the cell rather
     * than leaving an empty row behind.
     */
    async setMealPlanCell(tripId, day, slot, { recipeId = null, freeText = null } = {}) {
      return this.transaction(async () => {
        await all('DELETE FROM meal_plan WHERE trip_id = $1 AND day = $2 AND slot = $3', [
          tripId,
          day,
          slot,
        ]);
        if (recipeId == null && !freeText) return null;
        return get(
          `INSERT INTO meal_plan (trip_id, day, slot, recipe_id, free_text)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING *`,
          [tripId, day, slot, recipeId, freeText]
        );
      });
    },
  };
}

/**
 * Apply schema.sql only when the tables are missing (idempotent migration).
 *
 * Render overlaps the old and new instance during a deploy, so two processes
 * can reach this at once. The advisory lock makes the check-then-create atomic;
 * without it the loser crashes on "relation already exists" mid-boot.
 */
async function migrate(driver) {
  await driver.withConnection(async (client) => {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', ['ghrub_migrate']);
    try {
      const { rows } = await client.query("SELECT to_regclass('trip') AS t");
      if (!rows[0].t) {
        await client.exec(readFileSync(SCHEMA_PATH, 'utf8'));
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['ghrub_migrate']);
    }
  });
}
