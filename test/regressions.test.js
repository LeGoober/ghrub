import { readFileSync } from 'node:fs';
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

  it('an unseeded database can still file an item (production, 2026-10-06)', async () => {
    // Production's Neon database was never seeded: the Category select was
    // empty and every add failed the foreign key. Reference data now arrives
    // with the migration, so a brand-new database works out of the box.
    const fresh = await createDatabase(':memory:');
    const freshApp = await createApp(fresh);
    const trip = await fresh.createTrip({ name: 'Kgwedi ya Aug' });

    const page = await request(freshApp).get(`/trips/${trip.id}`);
    expect(page.text).toContain('<option value="produce">Fruits and Veggies</option>');

    const add = await request(freshApp)
      .post(`/trips/${trip.id}/items`)
      .type('form')
      .send({ item_name: 'GG', category_key: '' });
    expect(add.status).toBe(200);
    expect((await fresh.getTripItems(trip.id)).map((l) => l.item_name)).toEqual(['GG']);

    const track = await request(freshApp)
      .post('/inventory')
      .type('form')
      .send({ item_name: 'Eggs', qty_on_hand: '12', unit: 'carton', low_threshold: '1' });
    expect(track.status).toBe(200);
    expect(track.text).toContain('Eggs');
  });

  describe('typing into a form (2026-10-19: fields would not keep text)', () => {
    it('no form resets itself when a lookup inside it finishes', async () => {
      // htmx:afterRequest bubbles. The add form reset itself on success, and
      // the type-ahead GET from the input inside it is a success too — so
      // every pause while typing wiped what had been typed. Every reset must
      // check that the request was the form's own.
      const trip = await db.createTrip({ name: 'Shop' });
      for (const path of [`/trips/${trip.id}`, '/inventory', '/recipes', '/stores/prices']) {
        const res = await request(app).get(path);
        const handlers = res.text.match(/hx-on::after-request="[^"]*"/g) || [];
        for (const handler of handlers) {
          expect(handler, path).toContain('event.detail.elt === this');
        }
      }
      const foot = readFileSync('src/views/partials/foot.ejs', 'utf8');
      expect(foot).toContain("elt.matches?.('form')");
    });

    it('the trip type-ahead answers what the input actually sends', async () => {
      // hx-get on <input name="item_name"> sends ?item_name=, never ?q=.
      await db.getOrCreateItem('Milk', 'dairy_eggs');
      const trip = await db.createTrip({ name: 'Shop' });
      const res = await request(app).get(`/trips/${trip.id}/items/suggest?item_name=mi`);
      expect(res.text).toContain('data-pick-name="Milk"');
    });

    it('the prices type-ahead answers what the input actually sends', async () => {
      await db.getOrCreateItem('Milk', 'dairy_eggs');
      const res = await request(app).get('/stores/prices/suggest?item_name=mil');
      expect(res.text).toContain('data-pick-name="Milk"');
    });

    it('a new item tracked in the kitchen is filed by its name, not under Pantry', async () => {
      await request(app)
        .post('/inventory')
        .type('form')
        .send({ item_name: 'Eggs', qty_on_hand: '12', unit: 'carton', low_threshold: '1' });
      const [row] = await db.listInventory();
      expect(row.category_key).toBe('dairy_eggs');
    });

    it('the hidden attribute beats component display rules', () => {
      // .preview { display: flex } was showing "The receipt you selected"
      // and "Choose another" on the Scan page before any photo was picked.
      const css = readFileSync('public/css/app.css', 'utf8');
      expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important/);
    });
  });

  it('the dashboard shows what is running low', async () => {
    const eggs = await db.getOrCreateItem('Eggs', 'dairy_eggs');
    await db.setInventory(eggs.id, { qtyOnHand: 1, lowThreshold: 2 });
    const res = await request(app).get('/');
    expect(res.text).toContain('Running low');
    expect(res.text).toContain('Eggs · 1 left');
  });
});
