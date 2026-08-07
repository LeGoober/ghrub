import { Router } from 'express';
import { toCents, formatCents } from '../lib/money.js';
import { regulars, newThisList, oftenForgotten, cadence } from '../lib/insights.js';
import { applyBoughtToInventory, lowStockSuggestions } from '../lib/kitchen.js';
import { compareBasket } from '../lib/compare.js';
import { llmEnabled, buildFactSheet, requestExplanation } from '../lib/explain.js';
import { wrap } from './wrap.js';

function blankToNull(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

/** Group trip items by category in seed order; track each group's subtotal. */
function groupItemsByCategory(items) {
  const map = new Map();
  for (const it of items) {
    let group = map.get(it.category_key);
    if (!group) {
      group = { key: it.category_key, label: it.category_label, subtotal_cents: 0, lines: [] };
      map.set(it.category_key, group);
    }
    group.subtotal_cents += it.actual_cents ?? it.est_cents ?? 0;
    group.lines.push(it);
  }
  return [...map.values()];
}

/**
 * All trip + list routes. Every mutation renders a partial (the list groups
 * and/or the trip header) plus an out-of-band budget bar — never a full reload.
 *
 * Handlers are async since the Neon migration, and every one is wrap()ed so a
 * database error renders the 500 page instead of hanging the request.
 */
export function tripsRouter(db) {
  const router = Router();

  /**
   * The three habit buckets shown above the list (docs/03 M2). Defined once and
   * shared by the workspace page, the post-mutation partial and the per-bucket
   * GET routes, so a bucket's title can never drift between them.
   */
  const BUCKET_DEFS = [
    {
      key: 'regulars',
      title: 'Your regulars',
      blurb: 'On at least half of your past lists.',
      addable: true,
      rows: (tripId) => regulars(db, tripId),
    },
    {
      key: 'new',
      title: 'New this list',
      blurb: 'Never on one of your lists before.',
      addable: false,
      rows: (tripId) => newThisList(db, tripId),
    },
    {
      key: 'forgotten',
      title: 'Often forgotten',
      blurb: 'You list these a lot — but not this time.',
      addable: true,
      rows: (tripId) => oftenForgotten(db, tripId),
    },
    {
      key: 'low',
      title: 'Running low',
      blurb: 'At or below the level you set in your inventory.',
      addable: true,
      rows: (tripId) => lowStockSuggestions(db, tripId),
    },
  ];

  // The buckets are independent queries, so they resolve together rather than
  // in series — four sequential Neon round trips would show on every render.
  const buildBuckets = (tripId) =>
    Promise.all(BUCKET_DEFS.map(async (def) => ({ ...def, rows: await def.rows(tripId) })));

  const renderTripsList = async (res, error) => {
    const [rows, stores] = await Promise.all([db.listTrips(), db.listStores()]);
    const trips = await Promise.all(
      rows.map(async (t) => ({ ...t, budget: await db.budgetForTrip(t.id) }))
    );
    res.status(error ? 400 : 200).render('trips/index', {
      title: 'Trips',
      trips,
      stores,
      error: error || null,
    });
  };

  // Every list mutation also refreshes the habit buckets out-of-band: adding a
  // line changes what counts as new, forgotten or already-on-the-list, so a
  // stale bucket would keep offering an item you just added.
  const renderListsResponse = async (res, tripId) => {
    const [trip, budget, items, buckets, cadenceInfo] = await Promise.all([
      db.getTrip(tripId),
      db.budgetForTrip(tripId),
      db.getTripItems(tripId),
      buildBuckets(tripId),
      cadence(db),
    ]);
    // Tells the lazily-loaded store comparison to re-price itself (M3). Cheaper
    // than shipping the whole comparison in every mutation response.
    res.set('HX-Trigger', 'ghrub:list-changed');
    res.render('partials/lists-response', {
      trip,
      budget,
      groups: groupItemsByCategory(items),
      buckets,
      cadence: cadenceInfo,
      formatCents,
    });
  };

  const renderHeaderResponse = async (res, trip) => {
    const [stores, budget] = await Promise.all([db.listStores(), db.budgetForTrip(trip.id)]);
    res.render('partials/header-response', { trip, stores, budget, formatCents });
  };

  // GET / — dashboard: next/active trip + quick create
  router.get(
    '/',
    wrap(async (req, res) => {
      const [trips, stores] = await Promise.all([db.listTrips(), db.listStores()]);
      const active = trips.find((t) => t.status !== 'done') || trips[0] || null;
      res.render('dashboard', { title: 'ghrub', active, stores });
    })
  );

  // GET /trips — history list (full page)
  router.get(
    '/trips',
    wrap(async (req, res) => {
      await renderTripsList(res);
    })
  );

  // POST /trips — create; redirect to the workspace
  router.post(
    '/trips',
    wrap(async (req, res) => {
      const name = blankToNull(req.body.name);
      if (!name) {
        await renderTripsList(res, 'Trip name is required.');
        return;
      }
      const trip = await db.createTrip({
        name,
        start_date: blankToNull(req.body.start_date),
        end_date: blankToNull(req.body.end_date),
        shop_date: blankToNull(req.body.shop_date),
        budget_cents: toCents(req.body.budget),
        target_store_id: req.body.target_store_id ? Number(req.body.target_store_id) : null,
        notes: blankToNull(req.body.notes),
      });
      res.redirect(`/trips/${trip.id}`);
    })
  );

  // GET /trips/:id — the trip workspace (full page)
  router.get(
    '/trips/:id',
    wrap(async (req, res) => {
      const trip = await db.getTrip(Number(req.params.id));
      if (!trip) {
        res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
        return;
      }
      const [budget, items, buckets, cadenceInfo, stores, categories] = await Promise.all([
        db.budgetForTrip(trip.id),
        db.getTripItems(trip.id),
        buildBuckets(trip.id),
        cadence(db),
        db.listStores(),
        db.listCategories(),
      ]);
      res.render('trips/show', {
        title: trip.name,
        trip,
        budget,
        groups: groupItemsByCategory(items),
        buckets,
        cadence: cadenceInfo,
        llm: llmEnabled(),
        stores,
        categories,
        formatCents,
      });
    })
  );

  // PATCH /trips/:id — update name/dates/budget/status -> header partial + OOB bar
  router.patch(
    '/trips/:id',
    wrap(async (req, res) => {
      const trip = await db.getTrip(Number(req.params.id));
      if (!trip) {
        res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
        return;
      }
      const fields = {};
      const name = blankToNull(req.body.name);
      if (name) fields.name = name;
      if ('start_date' in req.body) fields.start_date = blankToNull(req.body.start_date);
      if ('end_date' in req.body) fields.end_date = blankToNull(req.body.end_date);
      if ('shop_date' in req.body) fields.shop_date = blankToNull(req.body.shop_date);
      if ('budget' in req.body) fields.budget_cents = toCents(req.body.budget);
      if ('status' in req.body) fields.status = req.body.status;
      if ('target_store_id' in req.body) {
        fields.target_store_id = req.body.target_store_id ? Number(req.body.target_store_id) : null;
      }
      await renderHeaderResponse(res, await db.updateTrip(trip.id, fields));
    })
  );

  // DELETE /trips/:id — remove; redirect to the list
  router.delete(
    '/trips/:id',
    wrap(async (req, res) => {
      const trip = await db.getTrip(Number(req.params.id));
      if (!trip) {
        res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
        return;
      }
      await db.deleteTrip(trip.id);
      res.redirect('/trips');
    })
  );

  // POST /trips/:id/items — add a line -> list groups + OOB budget bar
  router.post(
    '/trips/:id/items',
    wrap(async (req, res) => {
      const trip = await db.getTrip(Number(req.params.id));
      if (!trip) {
        res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
        return;
      }
      const itemName = blankToNull(req.body.item_name);
      if (!itemName) {
        res
          .status(400)
          .render('partials/error', { status: 400, message: 'Item name is required.' });
        return;
      }
      const categoryKey = req.body.category_key ? String(req.body.category_key) : null;
      await db.addTripItem(trip.id, {
        itemName,
        categoryKey,
        estCents: toCents(req.body.est),
        qty: req.body.qty ? Number(req.body.qty) : 1,
      });
      await renderListsResponse(res, trip.id);
    })
  );

  // PATCH /trips/:id/items/:lineId — tick bought / update qty, est, actual
  router.patch(
    '/trips/:id/items/:lineId',
    wrap(async (req, res) => {
      const trip = await db.getTrip(Number(req.params.id));
      if (!trip) {
        res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
        return;
      }
      const line = await db.getTripItem(Number(req.params.lineId));
      if (!line || line.trip_id !== trip.id) {
        res.status(404).render('partials/error', { status: 404, message: 'Item not found.' });
        return;
      }
      const fields = {};
      // Checkbox: present + value "1"/"on" means bought; absent means not bought.
      fields.bought = req.body.bought === '1' || req.body.bought === 'on' ? 1 : 0;
      if ('qty' in req.body) fields.qty = Number(req.body.qty) || 1;
      if ('est' in req.body) fields.est_cents = toCents(req.body.est);
      if ('actual' in req.body) fields.actual_cents = toCents(req.body.actual);
      if (req.body.category_key) fields.category_key = String(req.body.category_key);
      await db.updateTripItem(line.id, fields);

      // M4: buying restocks the kitchen. Only on the transition — this route also
      // fires when you edit a price on an already-ticked line, and that must not
      // add another unit.
      await applyBoughtToInventory(db, {
        itemId: line.item_id,
        qty: fields.qty ?? line.qty,
        wasBought: line.bought,
        isBought: fields.bought,
      });
      await renderListsResponse(res, trip.id);
    })
  );

  // DELETE /trips/:id/items/:lineId — remove a line
  router.delete(
    '/trips/:id/items/:lineId',
    wrap(async (req, res) => {
      const line = await db.getTripItem(Number(req.params.lineId));
      if (!line) {
        res.status(404).render('partials/error', { status: 404, message: 'Item not found.' });
        return;
      }
      // Removing a line you had already ticked takes that unit back off the
      // shelf — same transition as un-ticking it (M4).
      await applyBoughtToInventory(db, {
        itemId: line.item_id,
        qty: line.qty,
        wasBought: line.bought,
        isBought: 0,
      });
      await db.deleteTripItem(line.id);
      await renderListsResponse(res, line.trip_id);
    })
  );

  // GET /trips/:id/items/suggest?q= — type-ahead <ul> from the catalog
  router.get(
    '/trips/:id/items/suggest',
    wrap(async (req, res) => {
      const q = blankToNull(req.query.q);
      const items = q ? await db.searchItems(q, 8) : [];
      res.render('partials/suggest', { items });
    })
  );

  // GET /trips/:id/explain — optional narrative summary (M5, docs/06).
  // 404s unless ENABLE_LLM=true and a key is set, so the feature simply does
  // not exist by default rather than failing loudly.
  router.get(
    '/trips/:id/explain',
    wrap(async (req, res) => {
      const trip = await db.getTrip(Number(req.params.id));
      if (!trip) {
        res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
        return;
      }
      if (!llmEnabled()) {
        res.status(404).render('partials/error', {
          status: 404,
          message: 'Explanations are switched off (ENABLE_LLM).',
        });
        return;
      }

      const [budget, buckets, cadenceInfo, comparison] = await Promise.all([
        db.budgetForTrip(trip.id),
        buildBuckets(trip.id),
        cadence(db),
        compareBasket(db, trip.id),
      ]);
      const factSheet = buildFactSheet({
        trip,
        budget,
        buckets,
        cadence: cadenceInfo,
        comparison,
        formatCents,
      });

      try {
        const { text, model } = await requestExplanation(factSheet);
        res.render('partials/explain', { text, model, error: null, trip });
      } catch (err) {
        res.status(502).render('partials/explain', {
          text: null,
          model: null,
          error: err.message,
          trip,
        });
      }
    })
  );

  // GET /trips/:id/insights/{regulars,new,forgotten} — one bucket as a partial
  for (const def of BUCKET_DEFS) {
    router.get(
      `/trips/:id/insights/${def.key}`,
      wrap(async (req, res) => {
        const trip = await db.getTrip(Number(req.params.id));
        if (!trip) {
          res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
          return;
        }
        res.render('partials/insight-bucket', {
          trip,
          bucket: { ...def, rows: await def.rows(trip.id) },
        });
      })
    );
  }

  // POST /trips/:id/insights/add-regulars — bulk add every regular not yet listed
  router.post(
    '/trips/:id/insights/add-regulars',
    wrap(async (req, res) => {
      const trip = await db.getTrip(Number(req.params.id));
      if (!trip) {
        res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
        return;
      }
      // Sequential: addTripItem derives each line's position from the current
      // MAX(position), so adding these concurrently would hand several lines
      // the same position.
      for (const row of await regulars(db, trip.id)) {
        if (row.already_on_list) continue;
        await db.addTripItem(trip.id, { itemId: row.item_id, categoryKey: row.category_key });
      }
      await renderListsResponse(res, trip.id);
    })
  );

  return router;
}
