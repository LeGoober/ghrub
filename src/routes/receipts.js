import express, { Router } from 'express';
import { formatCents, toCents } from '../lib/money.js';
import {
  ACCEPTED_MEDIA_TYPES,
  parseReceipt,
  receiptScanEnabled,
  RECEIPT_MODEL,
} from '../lib/receipt.js';
import { wrap } from './wrap.js';

/**
 * A camera photo arrives as a base64 data URL in a JSON body, so this one route
 * needs a much larger cap than the app-wide 100kb default. It is scoped to the
 * scan route rather than raised globally, so no other endpoint will accept a
 * multi-megabyte body.
 */
const photoBody = express.json({ limit: '12mb' });

/** Split `data:image/jpeg;base64,AAAA` into its media type and payload. */
function readDataUrl(value) {
  const match = /^data:([a-z/+-]+);base64,(.+)$/i.exec(String(value ?? '').trim());
  if (!match) return null;
  return { mediaType: match[1].toLowerCase(), base64: match[2] };
}

const num = (value) => {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Receipt scanning (M6, docs/06).
 *
 * Three steps, and the middle one is the point: photograph → **review** →
 * apply. Claude proposes; the user confirms. Nothing reaches the database
 * until the review form is submitted, so a misread line is a correction rather
 * than a cleanup.
 */
export function receiptsRouter(db) {
  const router = Router();

  // GET /receipts — the capture page
  router.get(
    '/receipts',
    wrap(async (req, res) => {
      const [categories, stores] = await Promise.all([db.listCategories(), db.listStores()]);
      res.render('receipts/index', {
        title: 'Scan a receipt',
        enabled: receiptScanEnabled(),
        model: RECEIPT_MODEL,
        accepted: ACCEPTED_MEDIA_TYPES,
        categories,
        stores,
      });
    })
  );

  // POST /receipts/scan — photo in, proposed lines out. Reads nothing, writes nothing.
  router.post(
    '/receipts/scan',
    photoBody,
    wrap(async (req, res) => {
      if (!receiptScanEnabled()) {
        res.status(404).render('partials/error', {
          status: 404,
          message: 'Receipt scanning is not configured (ANTHROPIC_API_KEY).',
        });
        return;
      }

      const photo = readDataUrl(req.body?.image);
      if (!photo) {
        res
          .status(400)
          .render('partials/error', { status: 400, message: 'No photo came through.' });
        return;
      }

      const [categories, stores] = await Promise.all([db.listCategories(), db.listStores()]);

      let result;
      try {
        result = await parseReceipt({
          imageBase64: photo.base64,
          mediaType: photo.mediaType,
          categoryKeys: categories.map((c) => c.key),
        });
      } catch (err) {
        // The message is already user-facing and never echoes the response body.
        res.status(502).render('partials/receipt-review', {
          result: null,
          error: err.message,
          categories,
          stores,
          formatCents,
        });
        return;
      }

      res.render('partials/receipt-review', {
        result,
        error: null,
        categories,
        stores,
        formatCents,
      });
    })
  );

  // POST /receipts/apply — commit the reviewed rows
  router.post(
    '/receipts/apply',
    wrap(async (req, res) => {
      const body = req.body ?? {};
      // Every row posts its index in `idx`, but an unticked checkbox submits
      // nothing at all — so the kept set is read from `keep`, not from the
      // presence of a row. Without this, unticking row 2 would silently shift
      // rows 3+ onto the wrong values.
      const indexes = []
        .concat(body.idx ?? [])
        .map((i) => String(i))
        .filter((i) => /^\d+$/.test(i));
      const kept = new Set([].concat(body.keep ?? []).map((i) => String(i)));

      const storeId = num(body.store_id);
      const recordPrices = body.record_prices === '1' || body.record_prices === 'on';
      const purchasedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.purchased_on ?? ''))
        ? String(body.purchased_on)
        : null;

      const stocked = [];
      const priced = [];

      // Sequential on purpose: two rows can name the same product, and racing
      // getOrCreateItem would let both miss the conflict and split the stock
      // across duplicate catalog entries.
      for (const idx of indexes) {
        if (!kept.has(idx)) continue;

        const name = String(body[`name_${idx}`] ?? '').trim();
        const categoryKey = String(body[`category_${idx}`] ?? '').trim();
        const qty = num(body[`qty_${idx}`]);
        // The review form edits prices in Rands, like every other money input
        // in the app; toCents is the single boundary back to integer cents.
        const unitCents = toCents(body[`price_${idx}`]);
        if (!name || !categoryKey || qty === null || qty <= 0) continue;

        const item = await db.getOrCreateItem(name, categoryKey);
        // Buying restocks the kitchen — the same movement a ticked trip line
        // makes (src/lib/kitchen.js), arrived at from the till slip instead.
        const row = await db.adjustInventory(item.id, qty);
        stocked.push({ name: item.name, qty, onHand: row.qty_on_hand });

        if (recordPrices && storeId && unitCents !== null && unitCents > 0) {
          await db.upsertStorePrice(item.id, storeId, unitCents, purchasedOn);
          priced.push(item.name);
        }
      }

      const [lowStock, store] = await Promise.all([
        db.lowStockItems(),
        storeId ? db.listStores().then((all) => all.find((s) => s.id === storeId) ?? null) : null,
      ]);

      res.render('partials/receipt-applied', {
        stocked,
        priced,
        store,
        lowStock,
        formatCents,
      });
    })
  );

  return router;
}
