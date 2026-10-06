import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from '../src/db/repo.js';
import { createApp } from '../src/server.js';
import {
  extractLines,
  findDate,
  findStore,
  guessCategory,
  matchCatalog,
  nameScore,
  normaliseName,
  readQrPayload,
  readReceiptText,
} from '../src/lib/receipt-text.js';

const KEYS = [
  'produce',
  'meat_seafood',
  'bread_grains',
  'dairy_eggs',
  'spices_condiments',
  'pantry',
  'canned',
  'frozen',
  'water',
  'snacks',
];

const CATALOG = [
  { id: 1, name: 'Eggs', category_key: 'dairy_eggs' },
  { id: 2, name: 'Chicken breasts', category_key: 'meat_seafood' },
  { id: 3, name: 'Chicken', category_key: 'meat_seafood' },
  { id: 4, name: 'Maize meal', category_key: 'bread_grains' },
  { id: 5, name: 'Spinach', category_key: 'produce' },
  { id: 6, name: 'Milk', category_key: 'dairy_eggs' },
];

/** A Checkers-shaped slip, the way Tesseract hands it back. */
const SLIP = `CHECKERS HYPER
SANDTON CITY
TEL 011 555 1234
TAX INVOICE
FRESH LARGE EGGS 18S      54.99 A
CHKN BRST FLLT 1KG        89.99
WHITE STAR MAIZE MEAL 2.5KG 32.49
SPINACH
2 @ 14.99                 29.98
XTRA SAVINGS              -5.00
BANANAS LOOSE
0.746 kg @ 21.99/kg       16.40
TOTAL SAVINGS             5.00
TOTAL                    218.85
CARD                     218.85
CHANGE                    0.00
05/10/2026 14:32`;

describe('local receipt reading', () => {
  describe('walking the slip', () => {
    const { items, totalCents } = extractLines(SLIP);
    const byName = Object.fromEntries(items.map((i) => [i.raw, i]));

    it('finds every product line and nothing from the header or payment block', () => {
      expect(items.map((i) => i.raw)).toEqual([
        'FRESH LARGE EGGS 18S',
        'CHKN BRST FLLT 1KG',
        'WHITE STAR MAIZE MEAL 2.5KG',
        'SPINACH',
        'BANANAS LOOSE',
      ]);
    });

    it('reads the total, and not the TOTAL SAVINGS line above it', () => {
      expect(totalCents).toBe(21885);
    });

    it('attaches a "2 @ 14.99" line to the name above it', () => {
      expect(byName.SPINACH.qty).toBe(2);
    });

    it('takes a saving off the line it follows, not the whole basket', () => {
      expect(byName.SPINACH.lineCents).toBe(2498);
    });

    it('reads a weighed line as one item at its charged amount', () => {
      expect(byName['BANANAS LOOSE']).toMatchObject({ qty: 1, lineCents: 1640 });
    });

    it('drops the VAT flag after a price', () => {
      expect(byName['FRESH LARGE EGGS 18S'].lineCents).toBe(5499);
    });

    it('repairs O-for-0 inside a price but leaves words alone', () => {
      const [line] = extractLines('MOO JUICE 24.O9').items;
      expect(line).toMatchObject({ raw: 'MOO JUICE', lineCents: 2409 });
    });

    it('never mistakes a pack size for a price', () => {
      const { items: lines } = extractLines('COKE 2.25L\n24.99');
      expect(lines).toEqual([expect.objectContaining({ raw: 'COKE 2.25L', lineCents: 2499 })]);
    });

    it('treats XTRA LARGE EGGS as a product, not an Xtra Savings discount', () => {
      const { items: lines } = extractLines('BREAD 18.99\nXTRA LARGE EGGS 6S 24.99');
      expect(lines.map((l) => l.lineCents)).toEqual([1899, 2499]);
    });

    it('reads a trailing minus as a discount', () => {
      const { items: lines } = extractLines('CHEESE 129.99\nPROMO 20.00-');
      expect(lines).toEqual([expect.objectContaining({ lineCents: 10999 })]);
    });

    it('reads a quantity prefixed onto the item line', () => {
      const [line] = extractLines('3 x YOGHURT 1KG 74.97').items;
      expect(line).toMatchObject({ raw: 'YOGHURT 1KG', qty: 3, unitCents: 2499, lineCents: 7497 });
    });
  });

  describe('header fields', () => {
    it('reads a South African day-first date', () => {
      expect(findDate('05/10/2026 14:32')).toBe('2026-10-05');
      expect(findDate('2026-10-05')).toBe('2026-10-05');
      expect(findDate('5 Oct 2026')).toBe('2026-10-05');
    });

    it('refuses an impossible date rather than misfiling the shop', () => {
      expect(findDate('31/02/2026')).toBeNull();
      expect(findDate('TEL 011 555 1234')).toBeNull();
    });

    it('names the retailer', () => {
      expect(findStore('PICK N PAY FAMILY')).toBe('Pick n Pay');
      expect(findStore('Spar Kloof')).toBe('Spar');
      expect(findStore('SPARKLING WATER')).toBeNull();
    });
  });

  describe('matching your catalog', () => {
    it('expands a till abbreviation onto the item you already buy', () => {
      expect(matchCatalog('CHKN BRST FLLT 1KG', CATALOG)?.item.name).toBe('Chicken breasts');
    });

    it('ignores the brand and size around a known product', () => {
      expect(matchCatalog('WHITE STAR MAIZE MEAL 2.5KG', CATALOG)?.item.name).toBe('Maize meal');
      expect(matchCatalog('FRESH LARGE EGGS 18S', CATALOG)?.item.name).toBe('Eggs');
    });

    it('does not force a match on something new', () => {
      expect(matchCatalog('BANANAS LOOSE', CATALOG)).toBeNull();
    });

    it('scores a product that only shares a word below the whole name', () => {
      expect(nameScore('MILK CHOCOLATE SLAB', 'Milk')).toBeLessThan(nameScore('MILK 2L', 'Milk'));
    });

    it('prefers a learnt alias over any fuzzy guess', () => {
      const aliases = new Map([[normaliseName('MLROSE CHDR 900G'), { id: 9, name: 'Cheese' }]]);
      expect(matchCatalog('MLROSE CHDR 900G', CATALOG, aliases)).toMatchObject({
        via: 'alias',
        item: { name: 'Cheese' },
      });
    });

    it('guesses a category for a product it has never seen', () => {
      expect(guessCategory('FROZEN PEAS 1KG', KEYS)).toBe('frozen');
      expect(guessCategory('PEANUT BUTTER 400G', KEYS)).toBe('pantry');
      expect(guessCategory('BANANAS', KEYS)).toBe('produce');
      expect(guessCategory('MYSTERY THING', KEYS)).toBe('pantry');
    });
  });

  describe('the whole proposal', () => {
    const result = readReceiptText(SLIP, { catalog: CATALOG, categoryKeys: KEYS });

    it('fills in the header', () => {
      expect(result).toMatchObject({
        store: 'Checkers',
        purchasedOn: '2026-10-05',
        totalCents: 21885,
        engine: 'local',
      });
    });

    it('adds the lines up so the review can check them against the total', () => {
      expect(result.linesCents).toBe(result.totalCents);
    });

    it('uses your own name and category for a matched line', () => {
      expect(result.items[1]).toMatchObject({
        name: 'Chicken breasts',
        raw: 'CHKN BRST FLLT 1KG',
        categoryKey: 'meat_seafood',
        confident: true,
      });
    });

    it('flags a line that is new to the catalog for a check', () => {
      expect(result.items.find((i) => i.raw === 'BANANAS LOOSE')).toMatchObject({
        name: 'Bananas Loose',
        categoryKey: 'produce',
        confident: false,
      });
    });

    it('flags a line the OCR was unsure of, even when it matched', () => {
      const [line] = readReceiptText([{ text: 'EGGS 18S 54.99', conf: 41 }], {
        catalog: CATALOG,
        categoryKeys: KEYS,
      }).items;
      expect(line).toMatchObject({ name: 'Eggs', confident: false });
    });
  });

  describe('QR codes', () => {
    it('reports a link as a link, never as items', () => {
      expect(readQrPayload('https://survey.example.co.za/r/123')).toEqual({
        kind: 'url',
        url: 'https://survey.example.co.za/r/123',
      });
    });

    it('reads an itemised JSON payload', () => {
      const qr = readQrPayload(
        JSON.stringify({ items: [{ name: 'Milk 2L', qty: 2, price: 24.99 }] })
      );
      expect(qr.kind).toBe('items');
      const [line] = extractLines(qr.lines).items;
      expect(line).toMatchObject({ raw: 'Milk 2L', qty: 2, lineCents: 4998 });
    });

    it('reads name;qty;price rows', () => {
      const qr = readQrPayload('Eggs 18s;1;54.99\nBread;2;18.99');
      expect(extractLines(qr.lines).items.map((i) => i.lineCents)).toEqual([5499, 3798]);
    });

    it('treats anything else as an opaque reference', () => {
      expect(readQrPayload('TXN-0042-998812')).toEqual({ kind: 'text', text: 'TXN-0042-998812' });
    });
  });

  describe('the routes', () => {
    let db;
    let app;

    beforeEach(async () => {
      db = await createDatabase(':memory:');
      for (const key of KEYS) await db.upsertCategory(key, key);
      await db.getOrCreateStore('Checkers');
      await db.getOrCreateItem('Chicken breasts', 'meat_seafood');
      app = await createApp(db);
    });

    const read = (body) => request(app).post('/receipts/read').send(body);

    it('turns OCR lines into a review form, and writes nothing', async () => {
      const res = await read({
        lines: [
          { text: 'CHECKERS', conf: 90 },
          { text: 'CHKN BRST FLLT 89.99', conf: 88 },
        ],
      });
      expect(res.status).toBe(200);
      expect(res.text).toContain('Check the reading');
      expect(res.text).toContain('value="Chicken breasts"');
      expect(res.text).toContain('name="raw_0" value="CHKN BRST FLLT"');
      expect(res.text).toContain('the photo never left it');
      expect(await db.count('inventory')).toBe(0);
    });

    it('says the QR is a link and still reads the printed lines', async () => {
      const res = await read({
        qr: 'https://example.co.za/e-receipt',
        lines: [{ text: 'BREAD 18.99', conf: 90 }],
      });
      expect(res.text).toContain('is a link, not the items');
      expect(res.text).toContain('href="https://example.co.za/e-receipt"');
      expect(res.text).toContain('value="Bread"');
    });

    it('prefers an itemised QR over the OCR of the same slip', async () => {
      const res = await read({
        qr: 'Eggs;1;54.99',
        lines: [{ text: 'EG6S 5A.99', conf: 30 }],
      });
      expect(res.text).toContain('value="Eggs"');
      expect(res.text).toContain("Read from the slip's QR code");
    });

    it('serves the whole OCR engine itself, so scanning needs no CDN', async () => {
      for (const file of [
        '/static/js/receipt-scan.js',
        '/static/vendor/tesseract/tesseract.min.js',
        '/static/vendor/tesseract/worker.min.js',
        '/static/vendor/tesseract-core/tesseract-core-simd-lstm.wasm.js',
        '/static/vendor/tesseract-core/tesseract-core-lstm.wasm.js',
        '/static/vendor/tesseract-lang/eng.traineddata.gz',
        '/static/vendor/jsqr/jsQR.js',
      ]) {
        const res = await request(app).head(file);
        expect(res.status, file).toBe(200);
      }
    });

    it('rejects a body with no text in it', async () => {
      const res = await read({ lines: [] });
      expect(res.status).toBe(400);
    });

    it('learns a corrected till spelling and reads it right next time', async () => {
      await request(app)
        .post('/receipts/apply')
        .type('form')
        .send({
          idx: ['0'],
          keep: ['0'],
          raw_0: 'MLROSE CHDR 900G',
          name_0: 'Cheese',
          qty_0: '1',
          price_0: '129.99',
          category_0: 'dairy_eggs',
        });

      const res = await read({ lines: [{ text: 'MLROSE CHDR 900G 119.99', conf: 92 }] });
      expect(res.text).toContain('value="Cheese"');
      expect(res.text).toContain('learnt');
    });

    describe('ticking off a trip', () => {
      let trip;
      let chicken;

      beforeEach(async () => {
        trip = await db.createTrip({ name: 'Next shop', status: 'shopping' });
        chicken = await db.getOrCreateItem('Chicken breasts', 'meat_seafood');
        await db.addTripItem(trip.id, { itemId: chicken.id, estCents: 8000 });
      });

      const apply = (fields) =>
        request(app)
          .post('/receipts/apply')
          .type('form')
          .send({ trip_id: String(trip.id), ...fields });

      it('offers the open trip in the review, selected', async () => {
        const res = await read({ lines: [{ text: 'CHKN BRST 89.99', conf: 90 }] });
        expect(res.text).toMatch(new RegExp(`<option value="${trip.id}" selected>Next shop`));
      });

      it('ticks a listed line with its real price, and adds the unlisted ones as bought', async () => {
        const res = await apply({
          idx: ['0', '1'],
          keep: ['0', '1'],
          name_0: 'Chicken breasts',
          qty_0: '1',
          price_0: '89.99',
          category_0: 'meat_seafood',
          name_1: 'Bananas',
          qty_1: '1',
          price_1: '16.40',
          category_1: 'produce',
        });
        expect(res.text).toContain('1 ticked off, 1 added');

        const lines = await db.getTripItems(trip.id);
        expect(lines.map((l) => [l.item_name, l.bought, l.actual_cents])).toEqual(
          expect.arrayContaining([
            ['Chicken breasts', 1, 8999],
            ['Bananas', 1, 1640],
          ])
        );
        expect((await db.getInventory(chicken.id)).qty_on_hand).toBe(1);
      });

      it('does not restock a line that was already ticked by hand', async () => {
        const [line] = await db.getTripItems(trip.id);
        await request(app)
          .patch(`/trips/${trip.id}/items/${line.id}`)
          .type('form')
          .send({ bought: '1' });
        expect((await db.getInventory(chicken.id)).qty_on_hand).toBe(1);

        await apply({
          idx: ['0'],
          keep: ['0'],
          name_0: 'Chicken breasts',
          qty_0: '1',
          price_0: '89.99',
          category_0: 'meat_seafood',
        });
        expect((await db.getInventory(chicken.id)).qty_on_hand).toBe(1);
      });

      it('merges the same product printed twice into one line', async () => {
        await apply({
          idx: ['0', '1'],
          keep: ['0', '1'],
          name_0: 'Chicken breasts',
          qty_0: '1',
          price_0: '89.99',
          category_0: 'meat_seafood',
          name_1: 'Chicken breasts',
          qty_1: '1',
          price_1: '79.99',
          category_1: 'meat_seafood',
        });
        const lines = await db.getTripItems(trip.id);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatchObject({ qty: 2, actual_cents: 16998, bought: 1 });
        expect((await db.getInventory(chicken.id)).qty_on_hand).toBe(2);
      });
    });
  });
});
