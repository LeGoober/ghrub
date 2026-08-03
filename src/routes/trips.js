import { Router } from 'express';
import { toCents, formatCents } from '../lib/money.js';
import { regulars, newThisList, oftenForgotten, cadence } from '../lib/insights.js';

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
  ];

  const buildBuckets = (tripId) => BUCKET_DEFS.map((def) => ({ ...def, rows: def.rows(tripId) }));

  const renderTripsList = (res, error) => {
    const trips = db.listTrips().map((t) => ({ ...t, budget: db.budgetForTrip(t.id) }));
    res.status(error ? 400 : 200).render('trips/index', {
      title: 'Trips',
      trips,
      stores: db.listStores(),
      error: error || null,
    });
  };

  // Every list mutation also refreshes the habit buckets out-of-band: adding a
  // line changes what counts as new, forgotten or already-on-the-list, so a
  // stale bucket would keep offering an item you just added.
  const renderListsResponse = (res, tripId) => {
    const trip = db.getTrip(tripId);
    const budget = db.budgetForTrip(tripId);
    const groups = groupItemsByCategory(db.getTripItems(tripId));
    res.render('partials/lists-response', {
      trip,
      budget,
      groups,
      buckets: buildBuckets(tripId),
      cadence: cadence(db),
      formatCents,
    });
  };

  const renderHeaderResponse = (res, trip) => {
    const budget = db.budgetForTrip(trip.id);
    res.render('partials/header-response', {
      trip,
      stores: db.listStores(),
      budget,
      formatCents,
    });
  };

  // GET / — dashboard: next/active trip + quick create
  router.get('/', (req, res) => {
    const trips = db.listTrips();
    const active = trips.find((t) => t.status !== 'done') || trips[0] || null;
    res.render('dashboard', { title: 'ghrub', active, stores: db.listStores() });
  });

  // GET /trips — history list (full page)
  router.get('/trips', (req, res) => {
    renderTripsList(res);
  });

  // POST /trips — create; redirect to the workspace
  router.post('/trips', (req, res) => {
    const name = blankToNull(req.body.name);
    if (!name) {
      renderTripsList(res, 'Trip name is required.');
      return;
    }
    const trip = db.createTrip({
      name,
      start_date: blankToNull(req.body.start_date),
      end_date: blankToNull(req.body.end_date),
      shop_date: blankToNull(req.body.shop_date),
      budget_cents: toCents(req.body.budget),
      target_store_id: req.body.target_store_id ? Number(req.body.target_store_id) : null,
      notes: blankToNull(req.body.notes),
    });
    res.redirect(`/trips/${trip.id}`);
  });

  // GET /trips/:id — the trip workspace (full page)
  router.get('/trips/:id', (req, res) => {
    const trip = db.getTrip(Number(req.params.id));
    if (!trip) {
      res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
      return;
    }
    const budget = db.budgetForTrip(trip.id);
    const groups = groupItemsByCategory(db.getTripItems(trip.id));
    res.render('trips/show', {
      title: trip.name,
      trip,
      budget,
      groups,
      buckets: buildBuckets(trip.id),
      cadence: cadence(db),
      stores: db.listStores(),
      categories: db.listCategories(),
      formatCents,
    });
  });

  // PATCH /trips/:id — update name/dates/budget/status -> header partial + OOB bar
  router.patch('/trips/:id', (req, res) => {
    const trip = db.getTrip(Number(req.params.id));
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
    renderHeaderResponse(res, db.updateTrip(trip.id, fields));
  });

  // DELETE /trips/:id — remove; redirect to the list
  router.delete('/trips/:id', (req, res) => {
    const trip = db.getTrip(Number(req.params.id));
    if (!trip) {
      res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
      return;
    }
    db.deleteTrip(trip.id);
    res.redirect('/trips');
  });

  // POST /trips/:id/items — add a line -> list groups + OOB budget bar
  router.post('/trips/:id/items', (req, res) => {
    const trip = db.getTrip(Number(req.params.id));
    if (!trip) {
      res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
      return;
    }
    const itemName = blankToNull(req.body.item_name);
    if (!itemName) {
      res.status(400).render('partials/error', { status: 400, message: 'Item name is required.' });
      return;
    }
    const categoryKey = req.body.category_key ? String(req.body.category_key) : null;
    db.addTripItem(trip.id, {
      itemName,
      categoryKey,
      estCents: toCents(req.body.est),
      qty: req.body.qty ? Number(req.body.qty) : 1,
    });
    renderListsResponse(res, trip.id);
  });

  // PATCH /trips/:id/items/:lineId — tick bought / update qty, est, actual
  router.patch('/trips/:id/items/:lineId', (req, res) => {
    const trip = db.getTrip(Number(req.params.id));
    if (!trip) {
      res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
      return;
    }
    const line = db.getTripItem(Number(req.params.lineId));
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
    db.updateTripItem(line.id, fields);
    renderListsResponse(res, trip.id);
  });

  // DELETE /trips/:id/items/:lineId — remove a line
  router.delete('/trips/:id/items/:lineId', (req, res) => {
    const line = db.getTripItem(Number(req.params.lineId));
    if (!line) {
      res.status(404).render('partials/error', { status: 404, message: 'Item not found.' });
      return;
    }
    db.deleteTripItem(line.id);
    renderListsResponse(res, line.trip_id);
  });

  // GET /trips/:id/items/suggest?q= — type-ahead <ul> from the catalog
  router.get('/trips/:id/items/suggest', (req, res) => {
    const q = blankToNull(req.query.q);
    const items = q ? db.searchItems(q, 8) : [];
    res.render('partials/suggest', { items });
  });

  // GET /trips/:id/insights/{regulars,new,forgotten} — one bucket as a partial
  for (const def of BUCKET_DEFS) {
    router.get(`/trips/:id/insights/${def.key}`, (req, res) => {
      const trip = db.getTrip(Number(req.params.id));
      if (!trip) {
        res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
        return;
      }
      res.render('partials/insight-bucket', {
        trip,
        bucket: { ...def, rows: def.rows(trip.id) },
      });
    });
  }

  // POST /trips/:id/insights/add-regulars — bulk add every regular not yet listed
  router.post('/trips/:id/insights/add-regulars', (req, res) => {
    const trip = db.getTrip(Number(req.params.id));
    if (!trip) {
      res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
      return;
    }
    for (const row of regulars(db, trip.id)) {
      if (row.already_on_list) continue;
      db.addTripItem(trip.id, { itemId: row.item_id, categoryKey: row.category_key });
    }
    renderListsResponse(res, trip.id);
  });

  return router;
}
