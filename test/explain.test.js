import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/server.js';
import { createDatabase } from '../src/db/repo.js';
import { runSeed } from '../scripts/seed.js';
import { formatCents } from '../src/lib/money.js';
import {
  llmEnabled,
  buildFactSheet,
  requestExplanation,
  EXPLAIN_MODEL,
} from '../src/lib/explain.js';

/** A successful Messages API response, shaped like the real thing. */
const okResponse = (text = 'You are tracking well this week.') => ({
  ok: true,
  status: 200,
  json: async () => ({
    model: EXPLAIN_MODEL,
    stop_reason: 'end_turn',
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text },
    ],
  }),
});

const ENABLED = { ENABLE_LLM: 'true', ANTHROPIC_API_KEY: 'sk-ant-test' };

describe('optional LLM explanation (M5)', () => {
  describe('the flag', () => {
    it('is off unless BOTH the flag and a key are present', () => {
      expect(llmEnabled({})).toBe(false);
      expect(llmEnabled({ ENABLE_LLM: 'false', ANTHROPIC_API_KEY: 'k' })).toBe(false);
      // The flag alone would fail at request time — treat it as unavailable.
      expect(llmEnabled({ ENABLE_LLM: 'true' })).toBe(false);
      expect(llmEnabled({ ANTHROPIC_API_KEY: 'k' })).toBe(false);
      expect(llmEnabled(ENABLED)).toBe(true);
    });

    it('accepts any casing of true', () => {
      expect(llmEnabled({ ENABLE_LLM: 'TRUE', ANTHROPIC_API_KEY: 'k' })).toBe(true);
    });

    it('refuses to call out when disabled', async () => {
      const fetchImpl = vi.fn();
      await expect(requestExplanation('facts', { env: {}, fetchImpl })).rejects.toThrow(
        'LLM is disabled'
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('the fact sheet', () => {
    let db;
    let trip;

    beforeEach(() => {
      db = createDatabase(':memory:');
      runSeed(db);
      trip = db.createTrip({
        name: 'Bambezela Spezial V5',
        start_date: '2026-08-10',
        end_date: '2026-08-20',
        budget_cents: 50000,
      });
      db.addTripItem(trip.id, { itemName: 'Eggs', categoryKey: 'dairy_eggs', estCents: 4000 });
    });

    const sheet = () =>
      buildFactSheet({
        trip: db.getTrip(trip.id),
        budget: db.budgetForTrip(trip.id),
        buckets: [{ key: 'regulars', title: 'Your regulars', rows: [{ name: 'Oats' }] }],
        cadence: {
          medianGapDays: 23,
          lastShopDate: '2026-03-06',
          suggestedNextShopDate: '2026-03-29',
        },
        comparison: { hasPrices: false },
        formatCents,
      });

    it('carries the numbers the model is meant to talk about', () => {
      const text = sheet();
      expect(text).toContain('Bambezela Spezial V5');
      expect(text).toContain('R500.00'); // the budget
      expect(text).toContain('R40.00'); // the running total
      expect(text).toContain('Your regulars: Oats');
      expect(text).toContain('about every 23 days');
    });

    it('says a budget is absent rather than inventing one', () => {
      const noBudget = db.createTrip({ name: 'No budget' });
      const text = buildFactSheet({
        trip: db.getTrip(noBudget.id),
        budget: db.budgetForTrip(noBudget.id),
        buckets: [],
        cadence: { medianGapDays: null },
        comparison: null,
        formatCents,
      });
      expect(text).toContain('Budget: none set');
      expect(text).not.toContain('undefined');
      expect(text).not.toContain('NaN');
    });

    it('omits empty buckets instead of emitting blank lines', () => {
      const text = buildFactSheet({
        trip: db.getTrip(trip.id),
        budget: db.budgetForTrip(trip.id),
        buckets: [{ key: 'new', title: 'New this list', rows: [] }],
        cadence: { medianGapDays: null },
        comparison: null,
        formatCents,
      });
      expect(text).not.toContain('New this list');
      expect(text.split('\n').every((line) => line.trim())).toBe(true);
    });
  });

  describe('the API call', () => {
    it('posts a well-formed request and returns the prose', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(okResponse('Steady week.'));
      const result = await requestExplanation('Trip: X', { env: ENABLED, fetchImpl });

      expect(result.text).toBe('Steady week.');

      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(init.headers['x-api-key']).toBe('sk-ant-test');
      expect(init.headers['anthropic-version']).toBe('2023-06-01');

      const body = JSON.parse(init.body);
      expect(body.model).toBe('claude-opus-5');
      expect(body.messages).toEqual([{ role: 'user', content: 'Trip: X' }]);
      expect(body.system).toContain('ghrub');
    });

    it('never sends parameters this model rejects with a 400', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(okResponse());
      await requestExplanation('facts', { env: ENABLED, fetchImpl });

      const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
      // temperature / top_p / top_k are removed on this model.
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('top_k');
      // Fixed thinking budgets are gone too — effort is the control.
      expect(body.thinking?.budget_tokens).toBeUndefined();
      expect(body.output_config.effort).toBe('low');
    });

    it('budgets tokens for thinking, which is on by default on this model', async () => {
      const fetchImpl = vi.fn().mockResolvedValue(okResponse());
      await requestExplanation('facts', { env: ENABLED, fetchImpl });

      const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
      // A cap sized for ~120 words of prose would truncate mid-sentence once
      // thinking tokens come out of the same budget.
      expect(body.max_tokens).toBeGreaterThanOrEqual(2048);
    });

    it('treats a safety refusal as a failure, not as empty prose', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ stop_reason: 'refusal', content: [] }),
      });
      await expect(requestExplanation('facts', { env: ENABLED, fetchImpl })).rejects.toThrow(
        /declined/i
      );
    });

    it('distinguishes a retryable outage from a rejected request', async () => {
      const busy = vi.fn().mockResolvedValue({ ok: false, status: 529 });
      await expect(requestExplanation('facts', { env: ENABLED, fetchImpl: busy })).rejects.toThrow(
        /busy/i
      );

      const bad = vi.fn().mockResolvedValue({ ok: false, status: 400 });
      await expect(requestExplanation('facts', { env: ENABLED, fetchImpl: bad })).rejects.toThrow(
        /rejected/i
      );
    });

    it('rejects an empty completion rather than rendering a blank card', async () => {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          stop_reason: 'end_turn',
          content: [{ type: 'thinking', thinking: '' }],
        }),
      });
      await expect(requestExplanation('facts', { env: ENABLED, fetchImpl })).rejects.toThrow(
        /empty/i
      );
    });
  });

  describe('the route', () => {
    let db;
    let app;
    let trip;

    beforeEach(() => {
      db = createDatabase(':memory:');
      runSeed(db);
      app = createApp(db);
      trip = db.createTrip({ name: 'Next shop', budget_cents: 50000 });
    });

    it('does not exist when the flag is off (the default)', async () => {
      expect(process.env.ENABLE_LLM).toBeUndefined();
      const res = await request(app).get(`/trips/${trip.id}/explain`);
      expect(res.status).toBe(404);
      expect(res.text).toContain('ENABLE_LLM');
    });

    it('leaves the trip workspace fully usable with the flag off', async () => {
      const res = await request(app).get(`/trips/${trip.id}`);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('Explain this shop');
      // Everything else still renders.
      expect(res.text).toContain('Your regulars');
      expect(res.text).toContain('id="budget-bar"');
    });
  });
});
