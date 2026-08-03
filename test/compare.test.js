import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/repo.js';
import { compareBasket } from '../src/lib/compare.js';

const CATEGORIES = [
  ['produce', 'Fruits and Veggies'],
  ['dairy_eggs', 'Dairy and Eggs'],
  ['pantry', 'Pantry Staples'],
];

describe('store comparison (src/lib/compare.js)', () => {
  let db;
  let trip;
  let checkers;
  let spar;
  let pnp;

  beforeEach(() => {
    db = createDatabase(':memory:');
    for (const [key, label] of CATEGORIES) db.upsertCategory(key, label);
    checkers = db.getOrCreateStore('Checkers');
    spar = db.getOrCreateStore('Spar');
    pnp = db.getOrCreateStore('Pick n Pay');
    trip = db.createTrip({ name: 'Compare shop' });
  });

  const line = (name, categoryKey = 'pantry', qty = 1) =>
    db.addTripItem(trip.id, { itemName: name, categoryKey, qty });

  it('reports nothing to compare before any price is recorded', () => {
    line('Eggs', 'dairy_eggs');
    const result = compareBasket(db, trip.id);
    expect(result.hasPrices).toBe(false);
    expect(result.cheapest).toBeNull();
    expect(result.splitShop).toBeNull();
  });

  it('totals a basket per store and picks the cheapest', () => {
    const eggs = line('Eggs', 'dairy_eggs');
    const milk = line('Milk', 'dairy_eggs');
    db.upsertStorePrice(eggs.item_id, checkers.id, 4000);
    db.upsertStorePrice(eggs.item_id, spar.id, 4500);
    db.upsertStorePrice(milk.item_id, checkers.id, 2000);
    db.upsertStorePrice(milk.item_id, spar.id, 1900);

    const result = compareBasket(db, trip.id);
    const byName = Object.fromEntries(result.stores.map((s) => [s.storeName, s]));

    expect(byName.Checkers.comparableCents).toBe(6000);
    expect(byName.Spar.comparableCents).toBe(6400);
    expect(result.cheapest.storeName).toBe('Checkers');
    expect(result.cheapest.savingVsNextCents).toBe(400);
    expect(byName.Checkers.isCheapest).toBe(true);
  });

  it('multiplies the price by the quantity', () => {
    const eggs = line('Eggs', 'dairy_eggs', 3);
    db.upsertStorePrice(eggs.item_id, checkers.id, 4000);

    const store = compareBasket(db, trip.id).stores[0];
    expect(store.subtotalCents).toBe(12000);
  });

  it('flags unpriced lines instead of treating them as free', () => {
    const eggs = line('Eggs', 'dairy_eggs');
    line('Caviar');
    db.upsertStorePrice(eggs.item_id, checkers.id, 4000);

    const store = compareBasket(db, trip.id).stores[0];
    expect(store.subtotalCents).toBe(4000); // NOT 4000 + 0 counted as priced
    expect(store.pricedCount).toBe(1);
    expect(store.unpricedCount).toBe(1);
    expect(store.unpricedNames).toEqual(['Caviar']);
  });

  it('does not let a store win by knowing fewer prices', () => {
    // Checkers knows one cheap line. Spar knows all three and is cheaper overall
    // on everything they can both price.
    const eggs = line('Eggs', 'dairy_eggs');
    const milk = line('Milk', 'dairy_eggs');
    const rice = line('Rice');
    db.upsertStorePrice(eggs.item_id, checkers.id, 1000);
    db.upsertStorePrice(eggs.item_id, spar.id, 1100);
    db.upsertStorePrice(milk.item_id, spar.id, 2000);
    db.upsertStorePrice(rice.item_id, spar.id, 3000);

    const result = compareBasket(db, trip.id);
    const byName = Object.fromEntries(result.stores.map((s) => [s.storeName, s]));

    // Raw subtotals would say Checkers R10 beats Spar R61 — meaningless.
    expect(byName.Checkers.subtotalCents).toBe(1000);
    expect(byName.Spar.subtotalCents).toBe(6100);
    // The verdict is taken on the one line both can price.
    expect(result.comparableLineCount).toBe(1);
    expect(byName.Checkers.comparableCents).toBe(1000);
    expect(byName.Spar.comparableCents).toBe(1100);
    // ...and it is explicitly marked as too thin to trust.
    expect(result.thinComparison).toBe(true);
  });

  it('does not call a comparison thin once most lines are priced everywhere', () => {
    for (const name of ['Eggs', 'Milk', 'Rice', 'Beans']) {
      const l = line(name);
      db.upsertStorePrice(l.item_id, checkers.id, 1000);
      db.upsertStorePrice(l.item_id, spar.id, 1100);
    }
    const result = compareBasket(db, trip.id);
    expect(result.comparableLineCount).toBe(4);
    expect(result.thinComparison).toBe(false);
  });

  it('reports a tie rather than inventing a winner', () => {
    const eggs = line('Eggs', 'dairy_eggs');
    db.upsertStorePrice(eggs.item_id, checkers.id, 4000);
    db.upsertStorePrice(eggs.item_id, spar.id, 4000);

    const result = compareBasket(db, trip.id);
    expect(result.cheapest.tied).toBe(true);
    expect(result.stores.every((s) => s.isCheapest === false)).toBe(true);
  });

  it('builds a split-shop run and quotes the saving against one store', () => {
    const eggs = line('Eggs', 'dairy_eggs');
    const milk = line('Milk', 'dairy_eggs');
    db.upsertStorePrice(eggs.item_id, checkers.id, 4000);
    db.upsertStorePrice(eggs.item_id, spar.id, 4500);
    db.upsertStorePrice(milk.item_id, checkers.id, 2500);
    db.upsertStorePrice(milk.item_id, spar.id, 1900);

    const split = compareBasket(db, trip.id).splitShop;

    expect(split.totalCents).toBe(5900); // 4000 at Checkers + 1900 at Spar
    expect(split.stops).toHaveLength(2);
    expect(split.bestSingleStoreCents).toBe(6400); // Checkers 4000+2500
    expect(split.savingCents).toBe(500);
    expect(split.worthIt).toBe(true);
  });

  it('says a split is not worth it when one store already wins every line', () => {
    const eggs = line('Eggs', 'dairy_eggs');
    const milk = line('Milk', 'dairy_eggs');
    db.upsertStorePrice(eggs.item_id, checkers.id, 4000);
    db.upsertStorePrice(eggs.item_id, spar.id, 4500);
    db.upsertStorePrice(milk.item_id, checkers.id, 1800);
    db.upsertStorePrice(milk.item_id, spar.id, 1900);

    const split = compareBasket(db, trip.id).splitShop;
    expect(split.stops).toHaveLength(1);
    expect(split.savingCents).toBe(0);
    expect(split.worthIt).toBe(false);
  });

  it('uses the most recent price when an item has been seen more than once', () => {
    const eggs = line('Eggs', 'dairy_eggs');
    db.upsertStorePrice(eggs.item_id, checkers.id, 3000, '2026-01-01');
    db.upsertStorePrice(eggs.item_id, checkers.id, 5000, '2026-06-01');

    expect(compareBasket(db, trip.id).stores[0].subtotalCents).toBe(5000);
    expect(db.latestPricesForItem(eggs.item_id)).toHaveLength(1);
    expect(db.latestPricesForItem(eggs.item_id)[0].price_cents).toBe(5000);
  });

  it('corrects, rather than duplicates, a price recorded twice on one day', () => {
    const eggs = line('Eggs', 'dairy_eggs');
    db.upsertStorePrice(eggs.item_id, checkers.id, 3000, '2026-01-01');
    db.upsertStorePrice(eggs.item_id, checkers.id, 3200, '2026-01-01');

    expect(db.count('store_price')).toBe(1);
    expect(compareBasket(db, trip.id).stores[0].subtotalCents).toBe(3200);
  });

  it('marks the winning quote on each line for the split hint', () => {
    const eggs = line('Eggs', 'dairy_eggs');
    db.upsertStorePrice(eggs.item_id, checkers.id, 4000);
    db.upsertStorePrice(eggs.item_id, spar.id, 4500);
    db.upsertStorePrice(eggs.item_id, pnp.id, 4200);

    const [view] = compareBasket(db, trip.id).lines;
    expect(view.cheapest.storeName).toBe('Checkers');
    expect(view.quotes.filter((q) => q.isCheapest)).toHaveLength(1);
    expect(view.pricedEverywhere).toBe(true);
  });
});
