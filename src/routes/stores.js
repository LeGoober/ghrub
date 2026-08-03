import { Router } from 'express';
import { toCents, formatCents } from '../lib/money.js';
import { compareBasket } from '../lib/compare.js';

/**
 * Store prices + basket comparison (M3, docs/06).
 *
 * `POST /stores/prices` returns the recorded-prices partial, never a full page.
 */
export function storesRouter(db) {
  const router = Router();

  const renderPricesTable = (res, status = 200, error = null) => {
    res.status(status).render('partials/price-rows', {
      prices: db.listStorePrices(),
      formatCents,
      error,
    });
  };

  // GET /stores/prices — full page: entry form + what has been recorded
  router.get('/stores/prices', (req, res) => {
    const focusItem = req.query.item ? db.searchItems(String(req.query.item), 1)[0] : null;
    res.render('stores/prices', {
      title: 'Store prices',
      stores: db.listStores(),
      prices: db.listStorePrices(),
      focusItem: focusItem || null,
      knownForFocus: focusItem ? db.latestPricesForItem(focusItem.id) : [],
      formatCents,
    });
  });

  // GET /stores/prices/suggest?q= — type-ahead, same partial as the trip list
  router.get('/stores/prices/suggest', (req, res) => {
    const q = String(req.query.q || '').trim();
    res.render('partials/suggest', { items: q ? db.searchItems(q, 8) : [] });
  });

  // POST /stores/prices — record a price -> partial rows
  router.post('/stores/prices', (req, res) => {
    const itemName = String(req.body.item_name || '').trim();
    const storeId = Number(req.body.store_id);
    const priceCents = toCents(req.body.price);

    if (!itemName || !storeId || priceCents == null) {
      renderPricesTable(res, 400, 'Pick an item, a store and a price.');
      return;
    }
    if (priceCents < 0) {
      renderPricesTable(res, 400, 'A price cannot be negative.');
      return;
    }

    // Creating the catalog entry here keeps the prices page usable for things
    // that are not on any list yet.
    const item = db.getOrCreateItem(itemName, req.body.category_key || 'pantry');
    db.upsertStorePrice(item.id, storeId, priceCents, req.body.seen_date || null);
    renderPricesTable(res);
  });

  // GET /trips/:id/compare — per-store basket totals (partial)
  router.get('/trips/:id/compare', (req, res) => {
    const trip = db.getTrip(Number(req.params.id));
    if (!trip) {
      res.status(404).render('partials/error', { status: 404, message: 'Trip not found.' });
      return;
    }
    res.render('partials/compare', {
      trip,
      comparison: compareBasket(db, trip.id),
      formatCents,
    });
  });

  return router;
}
