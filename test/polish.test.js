import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server.js';
import { createDatabase } from '../src/db/repo.js';
import { runSeed } from '../scripts/seed.js';

describe('PWA, empty and error states (M5)', () => {
  let db;
  let app;

  beforeEach(async () => {
    db = await createDatabase(':memory:');
    await runSeed(db);
    app = await createApp(db);
  });

  describe('installability', () => {
    it('serves the manifest from the root', async () => {
      const res = await request(app).get('/manifest.webmanifest');
      expect(res.status).toBe(200);

      const manifest = JSON.parse(res.text);
      expect(manifest.name).toContain('ghrub');
      expect(manifest.start_url).toBe('/');
      expect(manifest.display).toBe('standalone');
      expect(manifest.icons.length).toBeGreaterThan(0);
      expect(manifest.icons.some((i) => i.purpose === 'maskable')).toBe(true);
    });

    it('serves the service worker from the root so it can control every page', async () => {
      // Scope is bounded by the worker's own URL — at /static/sw.js it could
      // never intercept "/" or "/trips/:id".
      const res = await request(app).get('/sw.js');
      expect(res.status).toBe(200);
      expect(res.text).toContain('addEventListener');
    });

    it('links the manifest and a theme colour from every page', async () => {
      for (const path of ['/', '/trips', '/history', '/inventory']) {
        const res = await request(app).get(path);
        expect(res.status, path).toBe(200);
        expect(res.text, path).toContain('rel="manifest"');
        expect(res.text, path).toContain('name="theme-color"');
        expect(res.text, path).toContain('apple-touch-icon');
      }
    });

    it('registers the worker and offers a skip link', async () => {
      const res = await request(app).get('/');
      expect(res.text).toContain("serviceWorker.register('/sw.js')");
      expect(res.text).toContain('class="skip-link"');
      expect(res.text).toContain('id="main"');
    });

    it('never caches a mutation or someone else’s list', async () => {
      const sw = readFileSync('public/sw.js', 'utf8');
      // Serving a stale list mid-shop is worse than an honest offline page.
      expect(sw).toContain("request.method !== 'GET'");
      expect(sw).toContain('You are offline');
    });
  });

  describe('error states', () => {
    it('renders a human 404 page for an unknown URL', async () => {
      const res = await request(app).get('/no-such-page');
      expect(res.status).toBe(404);
      expect(res.text).toContain('Not found');
      expect(res.text).toContain('Back to the dashboard');
      expect(res.text).not.toContain('Cannot GET');
    });

    it('still 404s a missing trip with the inline partial', async () => {
      const res = await request(app).get('/trips/99999');
      expect(res.status).toBe(404);
      expect(res.text).toContain('Trip not found');
    });
  });

  describe('empty states', () => {
    it('guides a brand-new user rather than showing a blank app', async () => {
      const fresh = await createApp(await createDatabase(':memory:'));

      const home = await request(fresh).get('/');
      expect(home.text).toContain('No trips yet');

      const trips = await request(fresh).get('/trips');
      expect(trips.text).toContain('No trips yet');

      const history = await request(fresh).get('/history');
      expect(history.text).toContain('No trips yet');

      const inventory = await request(fresh).get('/inventory');
      expect(inventory.text).toContain('Nothing tracked yet');

      const prices = await request(fresh).get('/stores/prices');
      expect(prices.text).toContain('Nothing recorded yet');
    });

    it('tells a new trip what to do next instead of showing an empty list', async () => {
      const trip = await db.createTrip({ name: 'Empty shop' });
      const res = await request(app).get(`/trips/${trip.id}`);
      expect(res.text).toContain('Nothing on the list yet');

      // The store comparison is lazily loaded, so its empty state lives on its
      // own partial rather than in the workspace HTML.
      expect(res.text).toContain(`hx-get="/trips/${trip.id}/compare"`);
      const compare = await request(app).get(`/trips/${trip.id}/compare`);
      expect(compare.text).toContain('No prices on file');
    });
  });

  describe('mobile-first, aisle-usable', () => {
    it('keeps a viewport meta and 44px tap targets in the stylesheet', async () => {
      const res = await request(app).get('/');
      expect(res.text).toContain('width=device-width');

      const css = readFileSync('public/css/app.css', 'utf8');
      expect(css).toContain('min-height: 44px');
      // The budget bar has to stay visible while you scroll a long list.
      expect(css).toMatch(/\.budget-bar\s*\{[^}]*position:\s*sticky/);
    });

    it('ships a selected dark mode and honours reduced motion', async () => {
      const css = readFileSync('public/css/app.css', 'utf8');
      expect(css).toContain('prefers-color-scheme: dark');
      expect(css).toContain('prefers-reduced-motion: reduce');
      // Dark mode re-picks the chart mark rather than inverting the light one.
      expect(css).toMatch(/prefers-color-scheme: dark[\s\S]*--chart-mark:/);
      expect(css).toContain('focus-visible');
    });

    it('has no hardcoded white surface left to break dark mode', async () => {
      const css = readFileSync('public/css/app.css', 'utf8');
      const dark = css.slice(css.indexOf('prefers-color-scheme: dark'));
      const light = css.slice(0, css.indexOf('prefers-color-scheme: dark'));
      // Form controls and the type-ahead dropdown were the two offenders.
      expect(light).not.toMatch(/background:\s*#fff;/);
      expect(dark.length).toBeGreaterThan(0);
    });
  });
});
