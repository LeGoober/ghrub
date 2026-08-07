/**
 * Multi-store basket comparison (M3).
 *
 * No SQL here — prices come from `repo.latestPricesForTrip()` (docs/05).
 * Money stays integer cents; a line's cost is its price × qty, rounded once.
 *
 * The trap this module exists to avoid: **a store with fewer prices on file
 * looks cheaper.** If Checkers can price 8 of your 10 lines and Spar can price
 * all 10, summing what each one knows makes Checkers "win" purely by being
 * ignorant. So unpriced lines are flagged, never zeroed (docs/02), and the
 * cheapest-store verdict is decided only on the lines every store can price —
 * the *comparable basket*. Each store's full subtotal is still reported, with
 * its coverage, so nothing is hidden.
 */

/** A line's cost at one store: unit price × quantity, rounded to whole cents. */
function lineCost(priceCents, qty) {
  return Math.round(priceCents * (qty ?? 1));
}

/**
 * Compare a trip's basket across every store that has any price on file.
 *
 * @returns {{
 *   hasPrices: boolean,
 *   stores: Array<object>,
 *   lines: Array<object>,
 *   comparableLineCount: number,
 *   totalLineCount: number,
 *   cheapest: object|null,
 *   splitShop: object|null
 * }}
 */
export async function compareBasket(db, tripId) {
  const lines = await db.getTripItems(tripId);
  const priceRows = await db.latestPricesForTrip(tripId);

  // line id -> store id -> { priceCents, seenDate, costCents }
  const byLine = new Map();
  const storesSeen = new Map();
  for (const row of priceRows) {
    if (!byLine.has(row.line_id)) byLine.set(row.line_id, new Map());
    byLine.get(row.line_id).set(row.store_id, {
      storeId: row.store_id,
      storeName: row.store_name,
      priceCents: row.price_cents,
      seenDate: row.seen_date,
      costCents: lineCost(row.price_cents, row.qty),
    });
    storesSeen.set(row.store_id, row.store_name);
  }

  const storeIds = [...storesSeen.keys()];
  if (!lines.length || !storeIds.length) {
    return {
      hasPrices: false,
      stores: [],
      lines: [],
      comparableLineCount: 0,
      totalLineCount: lines.length,
      cheapest: null,
      splitShop: null,
    };
  }

  // Per-line view: every store's price, plus which store wins this line.
  const lineViews = lines.map((line) => {
    const quotes = byLine.get(line.id) ?? new Map();
    const priced = [...quotes.values()];
    const best = priced.length
      ? priced.reduce((a, b) => (b.costCents < a.costCents ? b : a))
      : null;
    return {
      lineId: line.id,
      itemName: line.item_name,
      qty: line.qty,
      categoryLabel: line.category_label,
      quotes: storeIds.map((storeId) => {
        const quote = quotes.get(storeId) ?? null;
        return quote
          ? { ...quote, isCheapest: best !== null && quote.costCents === best.costCents }
          : { storeId, storeName: storesSeen.get(storeId), priceCents: null, unpriced: true };
      }),
      cheapest: best,
      pricedEverywhere: storeIds.every((id) => quotes.has(id)),
    };
  });

  const comparable = lineViews.filter((l) => l.pricedEverywhere);

  const stores = storeIds.map((storeId) => {
    const priced = lineViews.filter((l) =>
      l.quotes.some((q) => q.storeId === storeId && !q.unpriced)
    );
    const unpriced = lineViews.filter((l) =>
      l.quotes.some((q) => q.storeId === storeId && q.unpriced)
    );
    const costAt = (line) => line.quotes.find((q) => q.storeId === storeId).costCents;
    return {
      storeId,
      storeName: storesSeen.get(storeId),
      // Everything this store can price — honest but NOT comparable across
      // stores with different coverage.
      subtotalCents: priced.reduce((sum, l) => sum + costAt(l), 0),
      pricedCount: priced.length,
      unpricedCount: unpriced.length,
      unpricedNames: unpriced.map((l) => l.itemName),
      // The like-for-like number: only the lines every store can price.
      comparableCents: comparable.reduce((sum, l) => sum + costAt(l), 0),
    };
  });

  // Cheapest is decided on the comparable basket, never on the raw subtotal.
  let cheapest = null;
  if (comparable.length) {
    const best = stores.reduce((a, b) => (b.comparableCents < a.comparableCents ? b : a));
    const rest = stores.filter((s) => s.storeId !== best.storeId);
    const runnerUp = rest.length
      ? rest.reduce((a, b) => (b.comparableCents < a.comparableCents ? b : a))
      : null;
    cheapest = {
      ...best,
      savingVsNextCents: runnerUp ? runnerUp.comparableCents - best.comparableCents : null,
      tied: runnerUp ? runnerUp.comparableCents === best.comparableCents : false,
    };
  }
  for (const store of stores) {
    store.isCheapest = cheapest !== null && store.storeId === cheapest.storeId && !cheapest.tied;
  }

  return {
    hasPrices: true,
    stores: stores.sort(
      (a, b) => a.comparableCents - b.comparableCents || a.storeName.localeCompare(b.storeName)
    ),
    lines: lineViews,
    comparableLineCount: comparable.length,
    totalLineCount: lines.length,
    // A verdict drawn from one line out of ten is technically correct and
    // practically useless. The view states the basis either way, and softens
    // the claim when the comparable basket is this thin.
    thinComparison: comparable.length < 2 || comparable.length / lines.length < 0.5,
    cheapest,
    splitShop: splitShopHint(lineViews, stores),
  };
}

/**
 * "Buy each line wherever it is cheapest" — and what that actually saves.
 *
 * The saving is only quoted against a single store that can price *the same
 * lines*; otherwise the comparison would again reward a store for not knowing
 * a price. When no store covers the whole split set, the total still shows but
 * the saving is null.
 */
function splitShopHint(lineViews, stores) {
  const pricedLines = lineViews.filter((l) => l.cheapest);
  if (!pricedLines.length) return null;

  const totalCents = pricedLines.reduce((sum, l) => sum + l.cheapest.costCents, 0);

  const fullCoverage = stores.filter((store) =>
    pricedLines.every((l) => l.quotes.some((q) => q.storeId === store.storeId && !q.unpriced))
  );
  const bestSingle = fullCoverage.length
    ? fullCoverage
        .map((store) => ({
          store,
          total: pricedLines.reduce(
            (sum, l) => sum + l.quotes.find((q) => q.storeId === store.storeId).costCents,
            0
          ),
        }))
        .reduce((a, b) => (b.total < a.total ? b : a))
    : null;

  // Group the run into one stop per store.
  const stops = new Map();
  for (const line of pricedLines) {
    const key = line.cheapest.storeId;
    if (!stops.has(key)) {
      stops.set(key, {
        storeId: key,
        storeName: line.cheapest.storeName,
        items: [],
        subtotalCents: 0,
      });
    }
    const stop = stops.get(key);
    stop.items.push({ itemName: line.itemName, costCents: line.cheapest.costCents });
    stop.subtotalCents += line.cheapest.costCents;
  }

  return {
    totalCents,
    lineCount: pricedLines.length,
    stops: [...stops.values()].sort((a, b) => b.subtotalCents - a.subtotalCents),
    bestSingleStoreName: bestSingle ? bestSingle.store.storeName : null,
    bestSingleStoreCents: bestSingle ? bestSingle.total : null,
    savingCents: bestSingle ? bestSingle.total - totalCents : null,
    worthIt: bestSingle ? bestSingle.total - totalCents > 0 && stops.size > 1 : false,
  };
}
