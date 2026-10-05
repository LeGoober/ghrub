import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server.js';
import { createDatabase } from '../src/db/repo.js';
import { runSeed } from '../scripts/seed.js';

describe('routes (src/routes/trips.js)', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = await createDatabase(':memory:');
    await runSeed(db);
    app = await createApp(db);
  });

  it('serves the dashboard and the trips list', async () => {
    const home = await request(app).get('/');
    expect(home.status).toBe(200);
    expect(home.text).toContain('ghrub');

    const list = await request(app).get('/trips');
    expect(list.status).toBe(200);
    expect(list.text).toContain('Bambezela Spezial');
  });

  it('creates a trip (302) and opens its workspace with the budget in cents', async () => {
    const created = await request(app)
      .post('/trips')
      .type('form')
      .send({ name: 'Test shop', budget: '120.50', shop_date: '2026-08-08' });
    expect(created.status).toBe(302);

    const id = Number(created.headers.location.split('/').pop());
    expect((await db.getTrip(id)).budget_cents).toBe(12050);

    const ws = await request(app).get(created.headers.location);
    expect(ws.status).toBe(200);
    expect(ws.text).toContain('Test shop');
    expect(ws.text).toContain('R120.50');
  });

  it('adds an item and returns a partial with the OOB budget bar', async () => {
    const trip = await db.createTrip({ name: 'Shop', budget_cents: 10000 });
    const res = await request(app)
      .post(`/trips/${trip.id}/items`)
      .type('form')
      .send({ item_name: 'Eggs', category_key: 'dairy_eggs', est: '40' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Eggs');
    expect(res.text).toContain('hx-swap-oob="true"');
    expect(await db.getTripItems(trip.id)).toHaveLength(1);
    expect((await db.getTripItem((await db.getTripItems(trip.id))[0].id)).est_cents).toBe(4000);
  });

  it('ticks an item bought with an actual price', async () => {
    const trip = await db.createTrip({ name: 'Shop', budget_cents: 10000 });
    const line = await db.addTripItem(trip.id, {
      itemName: 'Tomatoes',
      categoryKey: 'produce',
      estCents: 2500,
    });

    const res = await request(app)
      .patch(`/trips/${trip.id}/items/${line.id}`)
      .type('form')
      .send({ bought: '1', actual: '28' });

    expect(res.status).toBe(200);
    expect((await db.getTripItem(line.id)).bought).toBe(1);
    expect((await db.getTripItem(line.id)).actual_cents).toBe(2800);
  });

  it('type-ahead suggests from the catalog', async () => {
    const trip = await db.createTrip({ name: 'Shop' });
    const res = await request(app).get(`/trips/${trip.id}/items/suggest`).query({ q: 'egg' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Eggs');
  });

  it('updates the trip header via a PATCH partial', async () => {
    const trip = await db.createTrip({ name: 'Old name', budget_cents: 5000 });
    const res = await request(app)
      .patch(`/trips/${trip.id}`)
      .type('form')
      .send({ name: 'New name', budget: '200' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('New name');
    expect(res.text).toContain('hx-swap-oob="true"');
    expect((await db.getTrip(trip.id)).budget_cents).toBe(20000);
  });

  it('deletes a line and returns the updated list partial', async () => {
    const trip = await db.createTrip({ name: 'Shop' });
    const line = await db.addTripItem(trip.id, {
      itemName: 'Milk',
      categoryKey: 'dairy_eggs',
      estCents: 1500,
    });

    const res = await request(app).delete(`/trips/${trip.id}/items/${line.id}`);
    expect(res.status).toBe(200);
    expect(await db.getTripItems(trip.id)).toHaveLength(0);
  });

  it('deletes a trip and redirects to the list with a 303, which becomes a GET', async () => {
    const trip = await db.createTrip({ name: 'Gone' });
    const res = await request(app).delete(`/trips/${trip.id}`);
    // A 302 would make the browser replay the DELETE against /trips.
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/trips');
    expect(await db.getTrip(trip.id)).toBeUndefined();
  });

  it('tells HTMX where to go after deleting a trip', async () => {
    const trip = await db.createTrip({ name: 'Gone' });
    const res = await request(app).delete(`/trips/${trip.id}`).set('HX-Request', 'true');
    expect(res.status).toBe(200);
    expect(res.headers['hx-redirect']).toBe('/trips');
  });

  it('re-adding an item already on the list leaves it alone', async () => {
    const trip = await db.createTrip({ name: 'Shop' });
    await db.upsertCategory('produce', 'Fruits and Veggies');
    const line = await db.addTripItem(trip.id, { itemName: 'Avocado', categoryKey: 'produce' });
    await db.updateTripItem(line.id, { bought: 1, actual_cents: 2500 });

    await request(app)
      .post(`/trips/${trip.id}/items`)
      .type('form')
      .send({ item_name: 'avocado', category_key: '' });

    const lines = await db.getTripItems(trip.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ bought: 1, actual_cents: 2500 });
  });

  it('files a new item by its name when the category is left on Auto', async () => {
    const trip = await db.createTrip({ name: 'Shop' });
    for (const [k, l] of [
      ['produce', 'Fruits and Veggies'],
      ['dairy_eggs', 'Dairy and Eggs'],
      ['pantry', 'Pantry'],
    ]) {
      await db.upsertCategory(k, l);
    }
    await request(app)
      .post(`/trips/${trip.id}/items`)
      .type('form')
      .send({ item_name: 'Cheddar cheese', category_key: '' });

    const [line] = await db.getTripItems(trip.id);
    expect(line.category_key).toBe('dairy_eggs');
  });

  it('returns a 4xx error partial for a missing trip', async () => {
    const res = await request(app).get('/trips/99999');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Trip not found');
  });
});
