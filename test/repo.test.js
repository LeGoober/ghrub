import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/repo.js';

// The schema treats category_key as FK -> category.key, so tests establish that
// invariant (mirrors what the seed does) before exercising JOIN-heavy queries.
const CATEGORIES = [
  ['produce', 'Fruits and Veggies'],
  ['pantry', 'Pantry Staples'],
  ['dairy_eggs', 'Dairy and Eggs'],
  ['bread_grains', 'Bread and Grains'],
];

describe('repo (src/db/repo.js)', () => {
  let db;

  beforeEach(async () => {
    db = await createDatabase(':memory:');
    for (const [key, label] of CATEGORIES) await db.upsertCategory(key, label);
  });

  it('applies schema.sql on boot when tables are missing', async () => {
    expect(await db.count('trip')).toBe(0);
    expect(await db.count('item')).toBe(0);
    expect(await db.count('store')).toBe(0);
  });

  it('creates, reads, updates and lists trips with integer-cents budget', async () => {
    const trip = await db.createTrip({
      name: 'Bambezela Spezial V5',
      shop_date: '2026-08-08',
      budget_cents: 50000,
    });
    expect(trip.id).toBeGreaterThan(0);

    const got = await db.getTrip(trip.id);
    expect(got.name).toBe('Bambezela Spezial V5');
    expect(got.budget_cents).toBe(50000);

    const updated = await db.updateTrip(trip.id, { status: 'shopping', budget_cents: 60000 });
    expect(updated.status).toBe('shopping');
    expect(updated.budget_cents).toBe(60000);

    expect(await db.listTrips()).toHaveLength(1);
    expect((await db.listTrips())[0].item_count).toBe(0);
  });

  it('deletes a trip and cascades its items', async () => {
    const trip = await db.createTrip({ name: 'Gone soon' });
    await db.addTripItem(trip.id, { itemName: 'Eggs', categoryKey: 'dairy_eggs', estCents: 4000 });
    expect(await db.count('trip_item')).toBe(1);

    await db.deleteTrip(trip.id);
    expect(await db.getTrip(trip.id)).toBeUndefined();
    expect(await db.count('trip_item')).toBe(0);
  });

  it('adds items by name, creating catalog entries', async () => {
    const trip = await db.createTrip({ name: 'Shop' });
    const line = await db.addTripItem(trip.id, {
      itemName: 'Oats',
      categoryKey: 'bread_grains',
      estCents: 3500,
    });

    expect(line.item_name).toBe('Oats');
    expect(line.est_cents).toBe(3500);
    expect(line.category_key).toBe('bread_grains');
    expect(await db.count('item')).toBe(1);
    expect(await db.getTripItems(trip.id)).toHaveLength(1);
  });

  it('upserts a line instead of duplicating (UNIQUE trip_id, item_id)', async () => {
    const trip = await db.createTrip({ name: 'Shop' });
    await db.addTripItem(trip.id, { itemName: 'Milk', categoryKey: 'dairy_eggs', estCents: 1500 });
    const again = await db.addTripItem(trip.id, {
      itemName: 'Milk',
      categoryKey: 'dairy_eggs',
      estCents: 1800,
    });

    expect(await db.getTripItems(trip.id)).toHaveLength(1);
    expect(again.est_cents).toBe(1800);
  });

  it('blends actual+est into the budget subtotal, per category', async () => {
    const trip = await db.createTrip({ name: 'Shop', budget_cents: 10000 });
    const a = await db.addTripItem(trip.id, {
      itemName: 'Tomatoes',
      categoryKey: 'produce',
      estCents: 1000,
    });
    const b = await db.addTripItem(trip.id, {
      itemName: 'Rice',
      categoryKey: 'pantry',
      estCents: 1000,
    });
    expect(b.est_cents).toBe(1000);
    await db.updateTripItem(a.id, { bought: 1, actual_cents: 1500 });

    const budget = await db.budgetForTrip(trip.id);
    expect(budget.subtotalCents).toBe(2500); // 1500 actual + 1000 est
    expect(budget.lineCount).toBe(2);
    expect(budget.boughtCount).toBe(1);
    expect(budget.state).toBe('ok');

    const produce = budget.byCategory.find((c) => c.category_key === 'produce');
    expect(produce.subtotal_cents).toBe(1500);
  });

  it('flags near (amber) and over (red) budget states', async () => {
    const trip = await db.createTrip({ name: 'Shop', budget_cents: 1000 });
    const line = await db.addTripItem(trip.id, {
      itemName: 'X',
      categoryKey: 'pantry',
      estCents: 999,
    });
    expect((await db.budgetForTrip(trip.id)).state).toBe('near');

    await db.updateTripItem(line.id, { est_cents: 1000 });
    expect((await db.budgetForTrip(trip.id)).state).toBe('over');
  });

  it('supports catalog type-ahead search', async () => {
    const trip = await db.createTrip({ name: 'Shop' });
    await db.addTripItem(trip.id, { itemName: 'Oats', categoryKey: 'bread_grains' });
    await db.addTripItem(trip.id, { itemName: 'Oat milk', categoryKey: 'dairy_eggs' });
    await db.addTripItem(trip.id, { itemName: 'Eggs', categoryKey: 'dairy_eggs' });

    const hits = await db.searchItems('oat');
    expect(hits.map((i) => i.name).sort()).toEqual(['Oat milk', 'Oats']);
  });
});
