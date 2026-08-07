import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from '../src/db/repo.js';
import { runSeed } from '../scripts/seed.js';
import {
  regulars,
  newThisList,
  oftenForgotten,
  cadence,
  spendHistory,
  insightsForTrip,
} from '../src/lib/insights.js';

describe('insights (src/lib/insights.js)', () => {
  let db;
  let trip;

  beforeEach(async () => {
    db = await createDatabase(':memory:');
    await runSeed(db);
    trip = await db.createTrip({ name: 'Next shop', budget_cents: 50000 });
  });

  it('surfaces the regulars docs/02 predicts from the seed history', async () => {
    const names = (await regulars(db, trip.id)).map((r) => r.name);

    // docs/02: "expected top regulars: Eggs, Oats, Chicken breasts, Noodles,
    // Spinach, Tomatoes, Bell peppers, Chickpeas, Tuna".
    for (const expected of [
      'Eggs',
      'Oats',
      'Noodles',
      'Spinach',
      'Tomatoes',
      'Bell peppers',
      'Chickpeas',
      'Tuna',
    ]) {
      expect(names, `${expected} should be a regular`).toContain(expected);
    }
  });

  it('counts listed, not bought — the bought=1 sketch in docs/02 loses Oats', async () => {
    const oats = (await regulars(db, trip.id)).find((r) => r.name === 'Oats');
    expect(oats.trips_listed).toBe(6);
    expect(oats.trips_bought).toBe(2); // would fail a >= 50%-bought rule
    expect(oats.ratio).toBeCloseTo(0.6);
  });

  it('excludes the open trip from both the count and the denominator', async () => {
    expect(await db.count('trip')).toBe(11); // 10 seeded + the new one
    expect((await regulars(db, trip.id))[0].total_trips).toBe(10);
    expect((await regulars(db, null))[0].total_trips).toBe(11);
  });

  it('flags regulars already on the list instead of dropping them', async () => {
    await db.addTripItem(trip.id, { itemName: 'Eggs', categoryKey: 'dairy_eggs' });
    const eggs = (await regulars(db, trip.id)).find((r) => r.name === 'Eggs');
    expect(eggs.already_on_list).toBe(true);
    expect((await regulars(db, trip.id)).find((r) => r.name === 'Spinach').already_on_list).toBe(
      false
    );
  });

  it('reports items never seen before as new this list', async () => {
    expect(await newThisList(db, trip.id)).toHaveLength(0);

    await db.addTripItem(trip.id, { itemName: 'Dragonfruit', categoryKey: 'produce' });
    await db.addTripItem(trip.id, { itemName: 'Eggs', categoryKey: 'dairy_eggs' });

    const names = (await newThisList(db, trip.id)).map((r) => r.name);
    expect(names).toEqual(['Dragonfruit']); // Eggs has history, so it is not new
  });

  it('keeps often-forgotten distinct from regulars and from what is listed', async () => {
    const forgotten = await oftenForgotten(db, trip.id);
    const regularIds = new Set((await regulars(db, trip.id)).map((r) => r.item_id));

    expect(forgotten.length).toBeGreaterThan(0);
    for (const row of forgotten) {
      expect(row.trips_listed).toBeGreaterThanOrEqual(3);
      expect(regularIds.has(row.item_id)).toBe(false);
    }

    // Chicken breasts is on 4 of 10 lists — under the regulars bar, so this is
    // the bucket that has to surface it (the M2 DoD names it).
    expect(forgotten.map((r) => r.name)).toContain('Chicken breasts');
  });

  it('drops an item from often-forgotten once it is on the list', async () => {
    expect((await oftenForgotten(db, trip.id)).map((r) => r.name)).toContain('Chicken breasts');
    await db.addTripItem(trip.id, { itemName: 'Chicken breasts', categoryKey: 'meat_seafood' });
    expect((await oftenForgotten(db, trip.id)).map((r) => r.name)).not.toContain('Chicken breasts');
  });

  it('uses the median gap for cadence so one long break does not skew it', async () => {
    const c = await cadence(db);
    // Seed gaps are 15,15,27,31,137,6,56,14,19 days: the mean is dragged to ~36
    // by the Jul->Dec hole, the median is not.
    expect(c.medianGapDays).toBeLessThan(30);
    expect(c.suggestedNextShopDate > c.lastShopDate).toBe(true);
  });

  it('returns null cadence when there is nothing to measure', async () => {
    const fresh = await createDatabase(':memory:');
    expect((await cadence(fresh)).medianGapDays).toBeNull();
    expect((await cadence(fresh)).suggestedNextShopDate).toBeNull();
  });

  it('summarises spend per trip and per category in integer cents', async () => {
    const history = await spendHistory(db);
    expect(history.tripCount).toBe(11);
    expect(Number.isInteger(history.avgPerTripCents)).toBe(true);
    expect(history.totalCents).toBeGreaterThan(0);
    expect(history.overBudgetCount).toBeGreaterThan(0);
    expect(history.overBudgetCount).toBeLessThanOrEqual(history.budgetedCount);

    const top = history.byCategory[0];
    expect(Number.isInteger(top.avg_cents)).toBe(true);
    expect(top.category_label).toBeTruthy();
  });

  it('bundles the three buckets for a trip', async () => {
    const bundle = await insightsForTrip(db, trip.id);
    expect(Object.keys(bundle).sort()).toEqual([
      'cadence',
      'newThisList',
      'oftenForgotten',
      'regulars',
    ]);
  });
});
