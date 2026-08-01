import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server.js';
import { createDatabase } from '../src/db/repo.js';
import { runSeed } from '../scripts/seed.js';

describe('routes (src/routes/trips.js)', () => {
  let db;
  let app;

  beforeEach(() => {
    db = createDatabase(':memory:');
    runSeed(db);
    app = createApp(db);
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
    expect(db.getTrip(id).budget_cents).toBe(12050);

    const ws = await request(app).get(created.headers.location);
    expect(ws.status).toBe(200);
    expect(ws.text).toContain('Test shop');
    expect(ws.text).toContain('R120.50');
  });

  it('adds an item and returns a partial with the OOB budget bar', async () => {
    const trip = db.createTrip({ name: 'Shop', budget_cents: 10000 });
    const res = await request(app)
      .post(`/trips/${trip.id}/items`)
      .type('form')
      .send({ item_name: 'Eggs', category_key: 'dairy_eggs', est: '40' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('Eggs');
    expect(res.text).toContain('hx-swap-oob="true"');
    expect(db.getTripItems(trip.id)).toHaveLength(1);
    expect(db.getTripItem(db.getTripItems(trip.id)[0].id).est_cents).toBe(4000);
  });

  it('ticks an item bought with an actual price', async () => {
    const trip = db.createTrip({ name: 'Shop', budget_cents: 10000 });
    const line = db.addTripItem(trip.id, {
      itemName: 'Tomatoes',
      categoryKey: 'produce',
      estCents: 2500,
    });

    const res = await request(app)
      .patch(`/trips/${trip.id}/items/${line.id}`)
      .type('form')
      .send({ bought: '1', actual: '28' });

    expect(res.status).toBe(200);
    expect(db.getTripItem(line.id).bought).toBe(1);
    expect(db.getTripItem(line.id).actual_cents).toBe(2800);
  });

  it('type-ahead suggests from the catalog', async () => {
    const trip = db.createTrip({ name: 'Shop' });
    const res = await request(app).get(`/trips/${trip.id}/items/suggest`).query({ q: 'egg' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Eggs');
  });

  it('updates the trip header via a PATCH partial', async () => {
    const trip = db.createTrip({ name: 'Old name', budget_cents: 5000 });
    const res = await request(app)
      .patch(`/trips/${trip.id}`)
      .type('form')
      .send({ name: 'New name', budget: '200' });

    expect(res.status).toBe(200);
    expect(res.text).toContain('New name');
    expect(res.text).toContain('hx-swap-oob="true"');
    expect(db.getTrip(trip.id).budget_cents).toBe(20000);
  });

  it('deletes a line and returns the updated list partial', async () => {
    const trip = db.createTrip({ name: 'Shop' });
    const line = db.addTripItem(trip.id, {
      itemName: 'Milk',
      categoryKey: 'dairy_eggs',
      estCents: 1500,
    });

    const res = await request(app).delete(`/trips/${trip.id}/items/${line.id}`);
    expect(res.status).toBe(200);
    expect(db.getTripItems(trip.id)).toHaveLength(0);
  });

  it('deletes a trip and redirects to the list', async () => {
    const trip = db.createTrip({ name: 'Gone' });
    const res = await request(app).delete(`/trips/${trip.id}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/trips');
    expect(db.getTrip(trip.id)).toBeUndefined();
  });

  it('returns a 4xx error partial for a missing trip', async () => {
    const res = await request(app).get('/trips/99999');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Trip not found');
  });
});
