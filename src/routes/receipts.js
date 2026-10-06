import express, { Router } from 'express';
import { formatCents, toCents } from '../lib/money.js';
import {
  ACCEPTED_MEDIA_TYPES,
  parseReceipt,
  receiptScanEnabled,
  RECEIPT_MODEL,
} from '../lib/receipt.js';
import { normaliseName, readQrPayload, readReceiptText } from '../lib/receipt-text.js';
import { wrap } from './wrap.js';

/**
 * A camera photo arrives as a base64 data URL in a JSON body, so this one route
 * needs a much larger cap than the app-wide 100kb default. It is scoped to the
 * scan route rather than raised globally, so no other endpoint will accept a
 * multi-megabyte body.
 */
const photoBody = express.json({ limit: '12mb' });

/** OCR output is text: a long slip is a few kilobytes, never a megabyte. */
const textBody = express.json({ limit: '1mb' });

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

/** OCR lines as posted by the browser, bounded and stripped to text + confidence. */
function readOcrLines(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 400).map((line) => ({
    text: String(line?.text ?? '').slice(0, 200),
    conf: typeof line?.conf === 'number' ? line.conf : null,
  }));
}

/** Trips you could still be shopping for, the one in progress first. */
async function openTrips(db) {
  const trips = (await db.listTrips()).filter((t) => t.status !== 'done');
  return trips.sort(
    (a, b) => (a.status === 'shopping' ? 0 : 1) - (b.status === 'shopping' ? 0 : 1)
  );
}

/**
 * Receipt scanning (docs/06).
 *
 * Three steps, and the middle one is the point: photograph → **review** →
 * apply. The reading proposes; the user confirms. Nothing reaches the database
 * until the review form is submitted, so a misread line is a correction rather
 * than a cleanup.
 *
 * Two readers produce the same proposal:
 *   - POST /receipts/read — the default. The phone has already turned the
 *     photo into text with Tesseract (WebAssembly, in the browser) and decoded
 *     any QR code; this route applies the till-slip rules in
 *     src/lib/receipt-text.js. No API key, no third party, no cost.
 *   - POST /receipts/scan — optional. Sends the photo to Claude, and only
 *     exists when ANTHROPIC_API_KEY is set.
 */
export function receiptsRouter(db) {
  const router = Router();

  const reviewContext = async () => {
    const [categories, stores, trips] = await Promise.all([
      db.listCategories(),
      db.listStores(),
      openTrips(db),
    ]);
    return { categories, stores, trips, formatCents };
  };

  // GET /receipts — the capture page
  router.get(
    '/receipts',
    wrap(async (req, res) => {
      res.render('receipts/index', {
        title: 'Scan a receipt',
        llmEnabled: receiptScanEnabled(),
        model: RECEIPT_MODEL,
        accepted: ACCEPTED_MEDIA_TYPES,
      });
    })
  );

  // POST /receipts/read — OCR text and/or a QR payload in, proposed lines out.
  // Reads the catalog, writes nothing.
  router.post(
    '/receipts/read',
    textBody,
    wrap(async (req, res) => {
      const ctx = await reviewContext();
      const qr = readQrPayload(req.body?.qr);
      // An itemised QR is exact; OCR of the same slip is a best effort.
      const lines = qr?.kind === 'items' ? qr.lines : readOcrLines(req.body?.lines);

      if (!lines.length) {
        res.status(qr ? 200 : 400).render('partials/receipt-review', {
          ...ctx,
          result: null,
          qr,
          error: qr ? null : 'No text came through from that photo.',
        });
        return;
      }

      const [catalog, aliasRows] = await Promise.all([db.listCatalog(), db.listAliases()]);
      const aliases = new Map(aliasRows.map((row) => [row.alias, row]));
      const result = readReceiptText(lines, {
        catalog,
        aliases,
        categoryKeys: ctx.categories.map((c) => c.key),
      });
      if (qr?.kind === 'items') result.engine = 'qr';

      res.render('partials/receipt-review', { ...ctx, result, qr, error: null });
    })
  );

  // POST /receipts/scan — the optional Claude reader. Photo in, proposed lines out.
  router.post(
    '/receipts/scan',
    photoBody,
    wrap(async (req, res) => {
      if (!receiptScanEnabled()) {
        res.status(404).render('partials/error', {
          status: 404,
          message: 'Reading with Claude is not configured (ANTHROPIC_API_KEY).',
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

      const ctx = await reviewContext();

      let result;
      try {
        result = await parseReceipt({
          imageBase64: photo.base64,
          mediaType: photo.mediaType,
          categoryKeys: ctx.categories.map((c) => c.key),
        });
      } catch (err) {
        // The message is already user-facing and never echoes the response body.
        res.status(502).render('partials/receipt-review', {
          ...ctx,
          result: null,
          qr: null,
          error: err.message,
        });
        return;
      }

      res.render('partials/receipt-review', {
        ...ctx,
        result: { ...result, engine: 'claude' },
        qr: null,
        error: null,
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
      const tripId = num(body.trip_id);
      const recordPrices = body.record_prices === '1' || body.record_prices === 'on';
      const purchasedOn = /^\d{4}-\d{2}-\d{2}$/.test(String(body.purchased_on ?? ''))
        ? String(body.purchased_on)
        : null;

      const trip = tripId ? await db.getTrip(tripId) : null;
      const stocked = [];
      const priced = [];
      const ticked = [];
      const added = [];
      let learnt = 0;

      // One transaction: a failure halfway through a slip must not leave half
      // the kitchen restocked and the other half not.
      await db.transaction(async () => {
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
          const lineCents =
            unitCents !== null && unitCents > 0 ? Math.round(unitCents * qty) : null;

          const item = await db.getOrCreateItem(name, categoryKey);

          // Learn the till's spelling, so the next slip needs no correction.
          // Only when it differs — "Eggs" printed as "EGGS" teaches nothing.
          const alias = normaliseName(body[`raw_${idx}`]);
          if (alias && alias !== normaliseName(item.name)) {
            await db.rememberAlias(alias, item.id);
            learnt += 1;
          }

          // Restock. With a trip chosen, the slip ticks the list off instead,
          // and stock follows the line's bought quantity — the same invariant
          // ticking a line by hand keeps (src/lib/kitchen.js), so a line that
          // was already ticked is not restocked a second time.
          let delta = qty;
          if (trip) {
            const line = await db.getTripLineByItem(trip.id, item.id);
            if (!line) {
              await db.addTripItem(trip.id, {
                itemId: item.id,
                categoryKey,
                qty,
                actualCents: lineCents,
                bought: 1,
              });
              added.push(item.name);
            } else if (ticked.includes(item.name) || added.includes(item.name)) {
              // The same product twice on one slip: add to the line, not over it.
              await db.updateTripItem(line.id, {
                qty: line.qty + qty,
                actual_cents: (line.actual_cents ?? 0) + (lineCents ?? 0) || null,
              });
            } else {
              await db.updateTripItem(line.id, {
                bought: 1,
                qty,
                actual_cents: lineCents ?? line.actual_cents,
              });
              if (line.bought) delta = qty - line.qty;
              ticked.push(item.name);
            }
          }

          const row = delta
            ? await db.adjustInventory(item.id, delta)
            : await db.getInventory(item.id);
          stocked.push({ name: item.name, qty, onHand: row?.qty_on_hand ?? qty });

          if (recordPrices && storeId && unitCents !== null && unitCents > 0) {
            await db.upsertStorePrice(item.id, storeId, unitCents, purchasedOn);
            priced.push(item.name);
          }
        }
      });

      const [lowStock, store] = await Promise.all([
        db.lowStockItems(),
        storeId ? db.listStores().then((all) => all.find((s) => s.id === storeId) ?? null) : null,
      ]);

      res.render('partials/receipt-applied', {
        stocked,
        priced,
        store,
        trip,
        ticked,
        added,
        learnt,
        lowStock,
        formatCents,
      });
    })
  );

  return router;
}
