import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server.js';
import { createDatabase } from '../src/db/repo.js';
import { runSeed } from '../scripts/seed.js';

/** Collapse HTML whitespace so assertions survive EJS line wrapping. */
const squash = (html) => html.replace(/\s+/g, ' ');

describe('store prices + compare routes (M3)', () => {
  let db;
  let app;
  let trip;
  let stores;

  beforeEach(async () => {
    db = await createDatabase(':memory:');
    await runSeed(db);
    app = await createApp(db);
    stores = await db.listStores();
    trip = await db.createTrip({ name: 'Compare shop' });
  });

  it('serves the prices page with an entry form', async () => {
    const res = await request(app).get('/stores/prices');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Record a price');
    for (const store of stores) expect(res.text).toContain(store.name);
  });

  it('records a price and returns a partial, not a page', async () => {
    const res = await request(app)
      .post('/stores/prices')
      .type('form')
      .send({ item_name: 'Rice', store_id: String(stores[0].id), price: '55.50' });

    expect(res.status).toBe(200);
    expect(res.text).not.toContain('<html');
    expect(res.text).toContain('Rice');
    expect(res.text).toContain('R55.50');
    expect((await db.listStorePrices())[0].price_cents).toBe(5550); // integer cents
  });

  it('rejects an incomplete or negative price with a 4xx partial', async () => {
    const missing = await request(app)
      .post('/stores/prices')
      .type('form')
      .send({ item_name: '', store_id: String(stores[0].id), price: '5' });
    expect(missing.status).toBe(400);
    expect(missing.text).toContain('Pick an item');

    const negative = await request(app)
      .post('/stores/prices')
      .type('form')
      .send({ item_name: 'Rice', store_id: String(stores[0].id), price: '-3' });
    expect(negative.status).toBe(400);
    expect(negative.text).toContain('cannot be negative');
    expect(await db.count('store_price')).toBe(0);
  });

  it('remembers the last price per store for an item', async () => {
    const item = await db.getOrCreateItem('Eggs', 'dairy_eggs');
    await db.upsertStorePrice(item.id, stores[0].id, 4000, '2026-01-01');
    await db.upsertStorePrice(item.id, stores[1].id, 4300, '2026-02-01');

    const res = await request(app).get('/stores/prices').query({ item: 'Eggs' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Last seen for');
    expect(res.text).toContain('R40.00');
    expect(res.text).toContain('R43.00');
    expect(res.text).toContain('2026-02-01'); // the seen date is shown
  });

  it('suggests catalog items on the prices page', async () => {
    const res = await request(app).get('/stores/prices/suggest').query({ q: 'egg' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Eggs');
  });

  it('compares a basket and highlights the cheapest store', async () => {
    const eggs = await db.addTripItem(trip.id, { itemName: 'Eggs', categoryKey: 'dairy_eggs' });
    const milk = await db.addTripItem(trip.id, { itemName: 'Milk', categoryKey: 'dairy_eggs' });
    await db.upsertStorePrice(eggs.item_id, stores[0].id, 4000);
    await db.upsertStorePrice(eggs.item_id, stores[1].id, 4500);
    await db.upsertStorePrice(milk.item_id, stores[0].id, 2000);
    await db.upsertStorePrice(milk.item_id, stores[1].id, 1900);

    const res = await request(app).get(`/trips/${trip.id}/compare`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('is cheapest');
    expect(res.text).toContain('badge-cheapest');
    // EJS wraps the sentence across source lines, so compare on collapsed text.
    expect(squash(res.text)).toContain('Compared on the 2 of 2 lines priced at every store');
    expect(res.text).not.toContain('<html');
  });

  it('shows the empty state when the basket has no prices', async () => {
    await db.addTripItem(trip.id, { itemName: 'Eggs', categoryKey: 'dairy_eggs' });
    const res = await request(app).get(`/trips/${trip.id}/compare`);
    expect(res.status).toBe(200);
    expect(res.text).toContain('No prices on file');
  });

  it('flags unpriced lines in the comparison rather than hiding them', async () => {
    const eggs = await db.addTripItem(trip.id, { itemName: 'Eggs', categoryKey: 'dairy_eggs' });
    await db.addTripItem(trip.id, { itemName: 'Caviar', categoryKey: 'pantry' });
    await db.upsertStorePrice(eggs.item_id, stores[0].id, 4000);

    const res = await request(app).get(`/trips/${trip.id}/compare`);
    expect(res.text).toContain('1 unpriced');
    expect(res.text).toContain('Caviar'); // named in the title attribute
  });

  it('404s the comparison for a trip that does not exist', async () => {
    const res = await request(app).get('/trips/99999/compare');
    expect(res.status).toBe(404);
  });

  it('lazily loads the comparison on the workspace and refreshes it on mutation', async () => {
    const workspace = await request(app).get(`/trips/${trip.id}`);
    expect(workspace.text).toContain(`hx-get="/trips/${trip.id}/compare"`);
    expect(workspace.text).toContain('ghrub:list-changed');

    const mutation = await request(app)
      .post(`/trips/${trip.id}/items`)
      .type('form')
      .send({ item_name: 'Bread', category_key: 'bread_grains' });
    expect(mutation.headers['hx-trigger']).toBe('ghrub:list-changed');
  });
});
