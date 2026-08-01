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

  beforeEach(() => {
    db = createDatabase(':memory:');
    for (const [key, label] of CATEGORIES) db.upsertCategory(key, label);
  });

  it('applies schema.sql on boot when tables are missing', () => {
    expect(db.count('trip')).toBe(0);
    expect(db.count('item')).toBe(0);
    expect(db.count('store')).toBe(0);
  });

  it('creates, reads, updates and lists trips with integer-cents budget', () => {
    const trip = db.createTrip({
      name: 'Bambezela Spezial V5',
      shop_date: '2026-08-08',
      budget_cents: 50000,
    });
    expect(trip.id).toBeGreaterThan(0);

    const got = db.getTrip(trip.id);
    expect(got.name).toBe('Bambezela Spezial V5');
    expect(got.budget_cents).toBe(50000);

    const updated = db.updateTrip(trip.id, { status: 'shopping', budget_cents: 60000 });
    expect(updated.status).toBe('shopping');
    expect(updated.budget_cents).toBe(60000);

    expect(db.listTrips()).toHaveLength(1);
    expect(db.listTrips()[0].item_count).toBe(0);
  });

  it('deletes a trip and cascades its items', () => {
    const trip = db.createTrip({ name: 'Gone soon' });
    db.addTripItem(trip.id, { itemName: 'Eggs', categoryKey: 'dairy_eggs', estCents: 4000 });
    expect(db.count('trip_item')).toBe(1);

    db.deleteTrip(trip.id);
    expect(db.getTrip(trip.id)).toBeUndefined();
    expect(db.count('trip_item')).toBe(0);
  });

  it('adds items by name, creating catalog entries', () => {
    const trip = db.createTrip({ name: 'Shop' });
    const line = db.addTripItem(trip.id, {
      itemName: 'Oats',
      categoryKey: 'bread_grains',
      estCents: 3500,
    });

    expect(line.item_name).toBe('Oats');
    expect(line.est_cents).toBe(3500);
    expect(line.category_key).toBe('bread_grains');
    expect(db.count('item')).toBe(1);
    expect(db.getTripItems(trip.id)).toHaveLength(1);
  });

  it('upserts a line instead of duplicating (UNIQUE trip_id, item_id)', () => {
    const trip = db.createTrip({ name: 'Shop' });
    db.addTripItem(trip.id, { itemName: 'Milk', categoryKey: 'dairy_eggs', estCents: 1500 });
    const again = db.addTripItem(trip.id, {
      itemName: 'Milk',
      categoryKey: 'dairy_eggs',
      estCents: 1800,
    });

    expect(db.getTripItems(trip.id)).toHaveLength(1);
    expect(again.est_cents).toBe(1800);
  });

  it('blends actual+est into the budget subtotal, per category', () => {
    const trip = db.createTrip({ name: 'Shop', budget_cents: 10000 });
    const a = db.addTripItem(trip.id, {
      itemName: 'Tomatoes',
      categoryKey: 'produce',
      estCents: 1000,
    });
    const b = db.addTripItem(trip.id, { itemName: 'Rice', categoryKey: 'pantry', estCents: 1000 });
    expect(b.est_cents).toBe(1000);
    db.updateTripItem(a.id, { bought: 1, actual_cents: 1500 });

    const budget = db.budgetForTrip(trip.id);
    expect(budget.subtotalCents).toBe(2500); // 1500 actual + 1000 est
    expect(budget.lineCount).toBe(2);
    expect(budget.boughtCount).toBe(1);
    expect(budget.state).toBe('ok');

    const produce = budget.byCategory.find((c) => c.category_key === 'produce');
    expect(produce.subtotal_cents).toBe(1500);
  });

  it('flags near (amber) and over (red) budget states', () => {
    const trip = db.createTrip({ name: 'Shop', budget_cents: 1000 });
    const line = db.addTripItem(trip.id, { itemName: 'X', categoryKey: 'pantry', estCents: 999 });
    expect(db.budgetForTrip(trip.id).state).toBe('near');

    db.updateTripItem(line.id, { est_cents: 1000 });
    expect(db.budgetForTrip(trip.id).state).toBe('over');
  });

  it('supports catalog type-ahead search', () => {
    const trip = db.createTrip({ name: 'Shop' });
    db.addTripItem(trip.id, { itemName: 'Oats', categoryKey: 'bread_grains' });
    db.addTripItem(trip.id, { itemName: 'Oat milk', categoryKey: 'dairy_eggs' });
    db.addTripItem(trip.id, { itemName: 'Eggs', categoryKey: 'dairy_eggs' });

    const hits = db.searchItems('oat');
    expect(hits.map((i) => i.name).sort()).toEqual(['Oat milk', 'Oats']);
  });
});
