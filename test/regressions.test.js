import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from '../src/db/repo.js';
import { createApp } from '../src/server.js';
import { cadence } from '../src/lib/insights.js';

/** Bugs found in the October 2026 audit, each pinned so it stays fixed. */
describe('audit regressions', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = await createDatabase(':memory:');
    await db.upsertCategory('dairy_eggs', 'Dairy and Eggs');
    await db.upsertCategory('pantry', 'Pantry Staples');
    app = await createApp(db);
  });

  it('an existing item keeps its category when a caller passes a fallback', async () => {
    await db.getOrCreateItem('Eggs', 'dairy_eggs');
    // What saving a recipe with Eggs in it does.
    const again = await db.getOrCreateItem('eggs', 'pantry');
    expect(again.category_key).toBe('dairy_eggs');
  });

  it('a missing category falls back instead of violating NOT NULL', async () => {
    const item = await db.getOrCreateItem('Mystery', null);
    expect(item.category_key).toBe('pantry');
  });

  it('removing an item from the inventory does not make it "running low"', async () => {
    const eggs = await db.getOrCreateItem('Eggs', 'dairy_eggs');
    await db.setInventory(eggs.id, { qtyOnHand: 6, lowThreshold: 2 });

    await request(app).delete(`/inventory/${eggs.id}`);

    expect(await db.getInventory(eggs.id)).toBeUndefined();
    expect(await db.lowStockItems()).toHaveLength(0);
  });

  it('a trip planned for the future is not counted as your last shop', async () => {
    const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    await db.createTrip({ name: 'a', shop_date: day(-28) });
    await db.createTrip({ name: 'b', shop_date: day(-14) });
    await db.createTrip({ name: 'planned', shop_date: day(10) });

    const c = await cadence(db);
    expect(c.lastShopDate).toBe(day(-14));
    expect(c.medianGapDays).toBe(14);
  });

  it('errors reach the page: htmx is configured to swap 4xx/5xx into the toast', async () => {
    const res = await request(app).get('/');
    expect(res.text).toContain('name="htmx-config"');
    expect(res.text).toContain('"target":"#toast"');
    expect(res.text).toContain('id="toast"');
  });

  it('the dashboard shows what is running low', async () => {
    const eggs = await db.getOrCreateItem('Eggs', 'dairy_eggs');
    await db.setInventory(eggs.id, { qtyOnHand: 1, lowThreshold: 2 });
    const res = await request(app).get('/');
    expect(res.text).toContain('Running low');
    expect(res.text).toContain('Eggs · 1 left');
  });
});
