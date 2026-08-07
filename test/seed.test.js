import { describe, it, expect } from 'vitest';
import { createDatabase } from '../src/db/repo.js';
import { runSeed } from '../scripts/seed.js';

describe('scripts/seed.js importer', () => {
  it('imports the history headlessly and is idempotent', async () => {
    const db = await createDatabase(':memory:');
    const first = await runSeed(db);

    expect(first.categories).toBe(13);
    expect(first.stores).toBe(3);
    expect(first.trips).toBe(10);
    expect(first.recipes).toBe(16);
    expect(first.items).toBeGreaterThan(50);
    expect(first.trip_items).toBeGreaterThan(100);
    expect(first.recipe_ingredients).toBeGreaterThan(0);

    // Re-running must not duplicate anything.
    const second = await runSeed(db);
    expect(second).toEqual(first);
  });

  it('stores money as integer cents (JSON is whole ZAR × 100)', async () => {
    const db = await createDatabase(':memory:');
    await runSeed(db);

    const trip = (await db.listTrips()).find((t) => t.name === 'Bambezela Spezial V3 (Apr)');
    expect(trip.budget_cents).toBe(28000); // budget: 280

    const eggs = (await db.getTripItems(trip.id)).find((i) => i.item_name === 'Eggs');
    expect(eggs.est_cents).toBe(4000); // est: 40
    expect(eggs.actual_cents).toBe(4000); // actual: 40
    expect(eggs.bought).toBe(1);
  });

  it('keeps null estimates/actuals as null (not 0)', async () => {
    const db = await createDatabase(':memory:');
    await runSeed(db);

    const trip = (await db.listTrips()).find((t) => t.name === 'Bambezela Spezial V3 (Apr)');
    const garlic = (await db.getTripItems(trip.id)).find((i) => i.item_name === 'Garlic');
    expect(garlic.actual_cents).toBeNull();
    expect(garlic.bought).toBe(0);
  });
});
