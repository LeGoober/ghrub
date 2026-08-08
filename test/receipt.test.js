import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createDatabase } from '../src/db/repo.js';
import { createApp } from '../src/server.js';
import {
  parseReceipt,
  receiptScanEnabled,
  receiptSchema,
  sanitise,
  RECEIPT_MODEL,
} from '../src/lib/receipt.js';

const CATEGORIES = [
  ['produce', 'Fruits and Veggies'],
  ['dairy_eggs', 'Dairy and Eggs'],
  ['pantry', 'Pantry Staples'],
];
const KEYS = CATEGORIES.map(([key]) => key);

/** A base64 payload — the bytes never matter because fetch is always stubbed. */
const PHOTO = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAA==';

/** Shape of a successful /v1/messages reply carrying structured output. */
const reply = (payload, extra = {}) => ({
  ok: true,
  status: 200,
  json: async () => ({
    model: RECEIPT_MODEL,
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    ...extra,
  }),
});

const ONE_ITEM = {
  store_name: 'Checkers',
  purchased_on: '2026-08-01',
  total_cents: 4999,
  items: [
    {
      name: 'Full cream milk',
      qty: 2,
      unit_price_cents: 2499,
      line_total_cents: 4998,
      category_key: 'dairy_eggs',
      confident: true,
    },
  ],
};

describe('receipt scanning (M6)', () => {
  describe('the flag', () => {
    it('is off without an API key and on with one', () => {
      expect(receiptScanEnabled({})).toBe(false);
      expect(receiptScanEnabled({ ANTHROPIC_API_KEY: 'sk-test' })).toBe(true);
    });

    it('refuses to call out when there is no key', async () => {
      await expect(
        parseReceipt(
          { imageBase64: 'AAAA', mediaType: 'image/jpeg', categoryKeys: KEYS },
          { env: {} }
        )
      ).rejects.toThrow(/not configured/i);
    });
  });

  describe('the schema sent to the model', () => {
    it('only allows categories that actually exist', () => {
      const schema = receiptSchema(KEYS);
      expect(schema.properties.items.items.properties.category_key.enum).toEqual(KEYS);
    });

    it('closes every object, which the schema dialect requires', () => {
      const schema = receiptSchema(KEYS);
      expect(schema.additionalProperties).toBe(false);
      expect(schema.properties.items.items.additionalProperties).toBe(false);
    });
  });

  describe('sanitising what comes back', () => {
    it('keeps a well-formed line intact', () => {
      const out = sanitise(ONE_ITEM, KEYS);
      expect(out.store).toBe('Checkers');
      expect(out.purchasedOn).toBe('2026-08-01');
      expect(out.totalCents).toBe(4999);
      expect(out.items).toEqual([
        {
          name: 'Full cream milk',
          qty: 2,
          unitPriceCents: 2499,
          lineTotalCents: 4998,
          categoryKey: 'dairy_eggs',
          confident: true,
        },
      ]);
      expect(out.dropped).toBe(0);
    });

    it('turns the -1 "not legible" sentinel into null, never a price of -1c', () => {
      const out = sanitise(
        {
          ...ONE_ITEM,
          total_cents: -1,
          items: [{ ...ONE_ITEM.items[0], unit_price_cents: -1, line_total_cents: -1 }],
        },
        KEYS
      );
      expect(out.totalCents).toBeNull();
      expect(out.items[0].unitPriceCents).toBeNull();
      expect(out.items[0].lineTotalCents).toBeNull();
    });

    it('drops a line whose category is not in the table (it would fail the FK)', () => {
      const out = sanitise(
        { ...ONE_ITEM, items: [{ ...ONE_ITEM.items[0], category_key: 'invented' }] },
        KEYS
      );
      expect(out.items).toHaveLength(0);
      expect(out.dropped).toBe(1);
    });

    it('drops a nameless line rather than creating a blank catalog item', () => {
      const out = sanitise({ ...ONE_ITEM, items: [{ ...ONE_ITEM.items[0], name: '  ' }] }, KEYS);
      expect(out.items).toHaveLength(0);
      expect(out.dropped).toBe(1);
    });

    it('clamps a misread quantity column instead of stocking 4000 eggs', () => {
      const out = sanitise({ ...ONE_ITEM, items: [{ ...ONE_ITEM.items[0], qty: 4000 }] }, KEYS);
      expect(out.items[0].qty).toBe(99);
    });

    it('rejects an absurd price as a misplaced decimal', () => {
      const out = sanitise(
        { ...ONE_ITEM, items: [{ ...ONE_ITEM.items[0], unit_price_cents: 99_999_999 }] },
        KEYS
      );
      expect(out.items[0].unitPriceCents).toBeNull();
    });

    it('refuses a date that is not ISO, which would misfile the shop', () => {
      expect(sanitise({ ...ONE_ITEM, purchased_on: '01/08/2026' }, KEYS).purchasedOn).toBeNull();
      expect(sanitise({ ...ONE_ITEM, purchased_on: '' }, KEYS).purchasedOn).toBeNull();
    });

    it('survives a reply with no items at all', () => {
      const out = sanitise({ store_name: '', purchased_on: '', total_cents: -1, items: [] }, KEYS);
      expect(out.items).toEqual([]);
      expect(out.store).toBeNull();
    });
  });

  describe('the request itself', () => {
    it('sends the photo as an image block with the model and schema', async () => {
      let sent;
      const fetchImpl = async (url, init) => {
        sent = { url, init, body: JSON.parse(init.body) };
        return reply(ONE_ITEM);
      };

      await parseReceipt(
        { imageBase64: 'AAAA', mediaType: 'image/jpeg', categoryKeys: KEYS },
        { env: { ANTHROPIC_API_KEY: 'sk-test' }, fetchImpl }
      );

      expect(sent.url).toContain('/v1/messages');
      expect(sent.body.model).toBe('claude-opus-5');
      const [image, text] = sent.body.messages[0].content;
      expect(image.type).toBe('image');
      expect(image.source).toEqual({
        type: 'base64',
        media_type: 'image/jpeg',
        data: 'AAAA',
      });
      expect(text.type).toBe('text');
      expect(sent.body.output_config.format.type).toBe('json_schema');
      expect(sent.body.output_config.format.schema.properties.items).toBeTruthy();
    });

    it('sends no sampling parameters — this model rejects them with a 400', async () => {
      let body;
      const fetchImpl = async (_url, init) => {
        body = JSON.parse(init.body);
        return reply(ONE_ITEM);
      };
      await parseReceipt(
        { imageBase64: 'AAAA', mediaType: 'image/jpeg', categoryKeys: KEYS },
        { env: { ANTHROPIC_API_KEY: 'sk-test' }, fetchImpl }
      );
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('top_k');
    });

    it('rejects a format the vision API does not take, before spending a token', async () => {
      const fetchImpl = vi.fn();
      await expect(
        parseReceipt(
          { imageBase64: 'AAAA', mediaType: 'image/tiff', categoryKeys: KEYS },
          { env: { ANTHROPIC_API_KEY: 'sk-test' }, fetchImpl }
        )
      ).rejects.toThrow(/not supported/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('rejects an oversized photo before uploading it', async () => {
      const fetchImpl = vi.fn();
      await expect(
        parseReceipt(
          { imageBase64: 'A'.repeat(9 * 1024 * 1024), mediaType: 'image/jpeg', categoryKeys: KEYS },
          { env: { ANTHROPIC_API_KEY: 'sk-test' }, fetchImpl }
        )
      ).rejects.toThrow(/too large/i);
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });

  describe('when the call goes wrong', () => {
    const call = (fetchImpl) =>
      parseReceipt(
        { imageBase64: 'AAAA', mediaType: 'image/jpeg', categoryKeys: KEYS },
        { env: { ANTHROPIC_API_KEY: 'sk-test' }, fetchImpl }
      );

    it('treats a 200 with stop_reason refusal as a failure, not as data', async () => {
      await expect(
        call(async () => ({
          ok: true,
          status: 200,
          json: async () => ({ stop_reason: 'refusal', content: [] }),
        }))
      ).rejects.toThrow(/declined/i);
    });

    it('explains a truncated reply rather than failing to parse it', async () => {
      await expect(
        call(async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            stop_reason: 'max_tokens',
            content: [{ type: 'text', text: '{"items":[' }],
          }),
        }))
      ).rejects.toThrow(/too long/i);
    });

    it('says to retry on a 429 and not to on a 400', async () => {
      await expect(call(async () => ({ ok: false, status: 429 }))).rejects.toThrow(/busy/i);
      await expect(call(async () => ({ ok: false, status: 400 }))).rejects.toThrow(/could not/i);
    });

    it('never leaks the error body, which can echo the request', async () => {
      await expect(
        call(async () => ({ ok: false, status: 400, text: async () => 'SECRET ECHO' }))
      ).rejects.toThrow(/^(?!.*SECRET).*$/);
    });
  });

  describe('the routes', () => {
    let db;
    let app;

    beforeEach(async () => {
      db = await createDatabase(':memory:');
      for (const [key, label] of CATEGORIES) await db.upsertCategory(key, label);
      await db.getOrCreateStore('Checkers');
      app = await createApp(db);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      delete process.env.ANTHROPIC_API_KEY;
    });

    it('explains itself instead of 500ing when no key is set', async () => {
      const res = await request(app).get('/receipts');
      expect(res.status).toBe(200);
      expect(res.text).toContain('Not switched on');
      expect(res.text).toContain('ANTHROPIC_API_KEY');
    });

    it('offers the camera once a key is set', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      const res = await request(app).get('/receipts');
      expect(res.text).toContain('Take a photo');
      expect(res.text).toContain('capture="environment"');
    });

    it('404s a scan when the feature is off', async () => {
      const res = await request(app).post('/receipts/scan').send({ image: PHOTO });
      expect(res.status).toBe(404);
    });

    it('returns a review form and writes nothing yet', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      vi.stubGlobal('fetch', async () => reply(ONE_ITEM));

      const res = await request(app).post('/receipts/scan').send({ image: PHOTO });

      expect(res.status).toBe(200);
      expect(res.text).toContain('Check the reading');
      expect(res.text).toContain('Full cream milk');
      // The whole point of the review step: scanning is read-only.
      expect(await db.count('inventory')).toBe(0);
      expect(await db.count('item')).toBe(0);
    });

    it('shows the model error in place instead of an error page', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      vi.stubGlobal('fetch', async () => ({ ok: false, status: 503 }));

      const res = await request(app).post('/receipts/scan').send({ image: PHOTO });
      expect(res.status).toBe(502);
      expect(res.text).toContain('Could not read that');
    });

    it('rejects a body that is not a photo', async () => {
      process.env.ANTHROPIC_API_KEY = 'sk-test';
      const res = await request(app).post('/receipts/scan').send({ image: 'not-a-data-url' });
      expect(res.status).toBe(400);
    });

    it('applies only the ticked rows, and stocks the kitchen', async () => {
      const res = await request(app)
        .post('/receipts/apply')
        .type('form')
        .send({
          idx: ['0', '1'],
          keep: ['0'], // row 1 is unticked
          name_0: 'Full cream milk',
          qty_0: '2',
          price_0: '24.99',
          category_0: 'dairy_eggs',
          name_1: 'Loose carrots',
          qty_1: '1',
          price_1: '15.00',
          category_1: 'produce',
        });

      expect(res.status).toBe(200);
      expect(res.text).toContain('Added to your kitchen');

      const inventory = await db.listInventory();
      expect(inventory.map((r) => r.item_name)).toEqual(['Full cream milk']);
      expect(inventory[0].qty_on_hand).toBe(2);
      // The unticked row must not have created a catalog entry either.
      expect((await db.searchItems('carrot')).length).toBe(0);
    });

    it('adds to what is already on the shelf rather than replacing it', async () => {
      const milk = await db.getOrCreateItem('Full cream milk', 'dairy_eggs');
      await db.setInventory(milk.id, { qtyOnHand: 3 });

      await request(app)
        .post('/receipts/apply')
        .type('form')
        .send({
          idx: ['0'],
          keep: ['0'],
          name_0: 'Full cream milk',
          qty_0: '2',
          category_0: 'dairy_eggs',
        });

      expect((await db.getInventory(milk.id)).qty_on_hand).toBe(5);
    });

    it('records prices against the chosen store when asked', async () => {
      const [store] = await db.listStores();
      await request(app)
        .post('/receipts/apply')
        .type('form')
        .send({
          idx: ['0'],
          keep: ['0'],
          name_0: 'Full cream milk',
          qty_0: '1',
          price_0: '24.99',
          category_0: 'dairy_eggs',
          record_prices: '1',
          store_id: String(store.id),
          purchased_on: '2026-08-01',
        });

      const prices = await db.listStorePrices();
      expect(prices).toHaveLength(1);
      expect(prices[0].price_cents).toBe(2499); // Rands in the form, cents in the DB
      expect(prices[0].seen_date).toBe('2026-08-01');
    });

    it('leaves prices alone when the box is unticked', async () => {
      const [store] = await db.listStores();
      await request(app)
        .post('/receipts/apply')
        .type('form')
        .send({
          idx: ['0'],
          keep: ['0'],
          name_0: 'Full cream milk',
          qty_0: '1',
          price_0: '24.99',
          category_0: 'dairy_eggs',
          store_id: String(store.id),
        });

      expect(await db.listStorePrices()).toHaveLength(0);
    });
  });
});
