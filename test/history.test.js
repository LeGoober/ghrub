import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server.js';
import { createDatabase } from '../src/db/repo.js';
import { runSeed } from '../scripts/seed.js';

describe('habit buckets + /history (M2 routes)', () => {
  let db;
  let app;
  let trip;

  beforeEach(async () => {
    db = await createDatabase(':memory:');
    await runSeed(db);
    app = await createApp(db);
    trip = await db.createTrip({ name: 'Next shop', budget_cents: 50000 });
  });

  it('shows the three habit buckets on a fresh trip workspace', async () => {
    const res = await request(app).get(`/trips/${trip.id}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('id="insight-buckets"');
    expect(res.text).toContain('Your regulars');
    expect(res.text).toContain('New this list');
    expect(res.text).toContain('Often forgotten');
    expect(res.text).toContain('Oats'); // a regular from the seed
    expect(res.text).toContain('You shop about every');
  });

  it('serves each bucket on its own as a partial', async () => {
    for (const [key, heading] of [
      ['regulars', 'Your regulars'],
      ['new', 'New this list'],
      ['forgotten', 'Often forgotten'],
    ]) {
      const res = await request(app).get(`/trips/${trip.id}/insights/${key}`);
      expect(res.status).toBe(200);
      expect(res.text).toContain(`id="bucket-${key}"`);
      expect(res.text).toContain(heading);
      expect(res.text).not.toContain('<html'); // a partial, never a full page
    }
  });

  it('404s a bucket for a trip that does not exist', async () => {
    const res = await request(app).get('/trips/99999/insights/regulars');
    expect(res.status).toBe(404);
  });

  it('adds every missing regular in one tap and refreshes the bar and buckets', async () => {
    expect(await db.getTripItems(trip.id)).toHaveLength(0);

    const res = await request(app).post(`/trips/${trip.id}/insights/add-regulars`);

    expect(res.status).toBe(200);
    expect((await db.getTripItems(trip.id)).length).toBeGreaterThanOrEqual(9);
    expect(res.text).toContain('hx-swap-oob="true"');
    expect(res.text).toContain('id="budget-bar"');
    expect(res.text).toContain('id="insight-buckets"');
    // The bucket now reports them as listed rather than offering them again.
    expect(res.text).toContain('already on this list');
  });

  it('is idempotent — adding all regulars twice does not duplicate lines', async () => {
    await request(app).post(`/trips/${trip.id}/insights/add-regulars`);
    const after = (await db.getTripItems(trip.id)).length;
    await request(app).post(`/trips/${trip.id}/insights/add-regulars`);
    expect(await db.getTripItems(trip.id)).toHaveLength(after);
  });

  it('adds a single suggestion and drops it from the bucket', async () => {
    const res = await request(app)
      .post(`/trips/${trip.id}/items`)
      .type('form')
      .send({ item_name: 'Chicken breasts', category_key: 'meat_seafood' });

    expect(res.status).toBe(200);
    expect((await db.getTripItems(trip.id)).map((l) => l.item_name)).toContain('Chicken breasts');

    const bucket = await request(app).get(`/trips/${trip.id}/insights/forgotten`);
    expect(bucket.text).not.toContain('Chicken breasts');
  });

  it('renders the history dashboard with both charts and a table view', async () => {
    const res = await request(app).get('/history');

    expect(res.status).toBe(200);
    expect(res.text).toContain('Spend per shop');
    expect(res.text).toContain('Average spend by category');
    expect(res.text).toContain('hero-figure');
    // Counted by the chart class, not by <svg>: the bottom tab bar draws its
    // icons as inline SVG too, so a bare <svg> count measures the nav as well.
    expect((res.text.match(/class="chart"/g) || []).length).toBe(2);
    // Every chart has a table-view twin, so no value is gated behind hover.
    expect(res.text).toContain('<table');
    expect(res.text).toContain('Bambezela Spezial');
    // A legend is present because the spend chart carries two segment types.
    expect(res.text).toContain('Within budget');
    expect(res.text).toContain('Over budget');
  });

  it('renders an empty history rather than dividing by zero', async () => {
    const empty = await createApp(await createDatabase(':memory:'));
    const res = await request(empty).get('/history');
    expect(res.status).toBe(200);
    expect(res.text).toContain('No trips yet');
    expect(res.text).not.toContain('NaN');
  });

  it('never emits NaN into chart coordinates', async () => {
    const res = await request(app).get('/history');
    expect(res.text).not.toContain('NaN');
    expect(res.text).not.toContain('undefined');
  });
});
