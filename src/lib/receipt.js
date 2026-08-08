/**
 * Receipt scanning (M6) — photograph a till slip, and Claude reads it back as
 * structured line items that restock the kitchen.
 *
 * Deliberately hand-rolled over Node's built-in fetch rather than pulling in
 * @anthropic-ai/sdk, for the same reason src/lib/explain.js is: docs/05 forbids
 * new dependencies without justification, and this is one POST to /v1/messages.
 * Both Claude calls in this app work the same way, which is worth more than the
 * ergonomics of an SDK on a two-call surface.
 *
 * NOTHING here writes to the database. Parsing returns a proposal; the user
 * reviews and edits it in the browser, and only the reviewed set is applied
 * (src/routes/receipts.js). A model misreading "2" as "12" must cost a glance,
 * not a corrupted inventory.
 *
 * API details that are easy to get wrong (verified against the claude-api
 * skill, not from memory):
 *  - `output_config.format` with a json_schema is what makes the reply parseable
 *    without regex-scraping prose. The old top-level `output_format` is dead.
 *  - Schemas may not use `minimum`/`maximum`/`minLength`, and every object needs
 *    `additionalProperties: false`. Ranges are therefore enforced below, in
 *    sanitise(), not by the schema.
 *  - `temperature`/`top_p`/`top_k` are rejected with a 400 on this model.
 *  - Thinking is ON by default on Claude Opus 5 and `max_tokens` caps thinking
 *    *plus* the JSON, so the budget is generous.
 *  - A safety classifier can decline with HTTP 200 + stop_reason "refusal", so
 *    stop_reason is checked before reading content.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Latest Claude model — the receipt is read by the same model that explains a shop. */
export const RECEIPT_MODEL = 'claude-opus-5';

/** What a phone camera produces. Anything else is rejected before we spend a token. */
export const ACCEPTED_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/** Decoded bytes. The API caps a whole request at 32MB; this leaves ample room. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

/** A till slip with more lines than this is not a grocery run — it is a mistake. */
const MAX_ITEMS = 120;

/** Guards a fat-fingered "1000 x milk" from a misread quantity column. */
const MAX_QTY = 99;

/** R10 000 for a single line is a misplaced decimal, not a purchase. */
const MAX_LINE_CENTS = 1_000_000;

/**
 * `-1` means "not legible" for every integer field.
 *
 * The alternative — `anyOf: [{type: 'integer'}, {type: 'null'}]` — is legal in
 * the schema dialect, but a sentinel keeps the schema to plain scalar types,
 * which is the part of the dialect with no caveats at all. Every sentinel is
 * normalised back to null in sanitise() before it leaves this module, so
 * nothing downstream ever sees a -1.
 */
const UNKNOWN = -1;

const SYSTEM_PROMPT = `You read South African grocery till slips for ghrub, a personal grocery app.

You will be given a photograph of a receipt. Return the purchase as structured data.

Rules:
- Transcribe ONLY what is printed on the slip. Never invent an item, a price, or a quantity. If the photo is blurry, cropped, or missing a field, report that field as unknown rather than guessing.
- Money is South African Rand. Report every amount in INTEGER CENTS: R24.99 is 2499. Never return a decimal.
- Use -1 for any number you cannot read, and "" for any text you cannot read. These mean "not legible" and are always better than a guess.
- name: the product as a shopper would say it, not the till's abbreviation. "MELROSE CHDR 900G" becomes "Melrose cheddar". Keep a size in the name only when it distinguishes the product.
- qty: how many units. A weighed item priced per kilogram is quantity 1 unless the slip states a count.
- unit_price_cents: the price for ONE unit. line_total_cents: what that line actually charged.
- category_key: pick the closest from the list allowed by the schema.
- confident: false when the line is smudged, ambiguous, or you had to interpret an abbreviation heavily. Be honest — a false here just asks the user to check that row.
- Skip anything that is not a purchased product: subtotals, VAT lines, change, loyalty points, payment method, discounts applied to the whole slip.
- purchased_on: the transaction date as YYYY-MM-DD. Not today's date, and not the VAT registration date.
- store_name: the retailer, e.g. "Checkers", "Spar", "Pick n Pay".
- If the image is not a receipt at all, return an empty items array and "" for the text fields.`;

/**
 * The JSON shape the model must return.
 *
 * `categoryKeys` comes from the caller's own category table, so the model can
 * only ever return a category that already exists — the line items are written
 * against a FK, and an invented key would fail on insert.
 */
export function receiptSchema(categoryKeys) {
  return {
    type: 'object',
    properties: {
      store_name: { type: 'string' },
      purchased_on: { type: 'string' },
      total_cents: { type: 'integer' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            qty: { type: 'number' },
            unit_price_cents: { type: 'integer' },
            line_total_cents: { type: 'integer' },
            category_key: { type: 'string', enum: categoryKeys },
            confident: { type: 'boolean' },
          },
          required: [
            'name',
            'qty',
            'unit_price_cents',
            'line_total_cents',
            'category_key',
            'confident',
          ],
          additionalProperties: false,
        },
      },
    },
    required: ['store_name', 'purchased_on', 'total_cents', 'items'],
    additionalProperties: false,
  };
}

/**
 * Whether receipt scanning is available. Unlike the M5 explanation feature this
 * has no separate flag: it is a real feature rather than an optional flourish,
 * so it is on whenever there is a key to call with, and the page explains
 * itself when there is not.
 */
export function receiptScanEnabled(env = process.env) {
  return Boolean(env.ANTHROPIC_API_KEY);
}

const isPositiveInt = (n) => Number.isInteger(n) && n > 0;

/**
 * Bring the model's reply back inside the bounds the app can store.
 *
 * Structured outputs guarantee the *shape* of the JSON, never that the values
 * are sane — a misread quantity column is still well-typed. Everything past
 * this function is trusted, so everything questionable is dropped or nulled
 * here, and `dropped` is reported so the UI can say what was ignored.
 *
 * @returns {{store: string|null, purchasedOn: string|null, totalCents: number|null,
 *   items: Array<object>, dropped: number}}
 */
export function sanitise(raw, categoryKeys) {
  const allowed = new Set(categoryKeys);
  const rows = Array.isArray(raw?.items) ? raw.items : [];
  const items = [];
  let dropped = 0;

  for (const row of rows.slice(0, MAX_ITEMS)) {
    const name = String(row?.name ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    // A line with no readable name cannot become a catalog item, and a category
    // outside the table would fail the foreign key on insert.
    if (!name || !allowed.has(row?.category_key)) {
      dropped += 1;
      continue;
    }

    const rawQty = Number(row?.qty);
    const qty = Number.isFinite(rawQty) && rawQty > 0 ? Math.min(rawQty, MAX_QTY) : 1;

    const cents = (value) => {
      const n = Number(value);
      return isPositiveInt(n) && n <= MAX_LINE_CENTS ? n : null;
    };

    items.push({
      name,
      qty,
      unitPriceCents: cents(row?.unit_price_cents),
      lineTotalCents: cents(row?.line_total_cents),
      categoryKey: row.category_key,
      confident: row?.confident !== false,
    });
  }

  dropped += Math.max(0, rows.length - MAX_ITEMS);

  const store = String(raw?.store_name ?? '').trim();
  const date = String(raw?.purchased_on ?? '').trim();
  const total = Number(raw?.total_cents);

  return {
    store: store || null,
    // Anything that is not an ISO date is the model failing to read the slip,
    // and a wrong date silently misfiles the whole shop.
    purchasedOn: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null,
    totalCents: isPositiveInt(total) && total !== UNKNOWN ? total : null,
    items,
    dropped,
  };
}

/**
 * Ask Claude to read a receipt photo.
 *
 * @param {{imageBase64: string, mediaType: string, categoryKeys: string[]}} input
 * @param {{env?: object, fetchImpl?: Function, signal?: AbortSignal}} [opts]
 *   `fetchImpl` is injectable so the tests never touch the network.
 * @returns {Promise<{store, purchasedOn, totalCents, items, dropped, model}>}
 */
export async function parseReceipt({ imageBase64, mediaType, categoryKeys }, opts = {}) {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  if (!receiptScanEnabled(env)) throw new Error('Receipt scanning is not configured.');
  if (!ACCEPTED_MEDIA_TYPES.includes(mediaType)) {
    throw new Error('That image format is not supported. Use a JPEG, PNG or WebP photo.');
  }
  if (!imageBase64) throw new Error('No photo was received.');
  // Base64 carries 3 bytes per 4 characters; checking here avoids uploading
  // several megabytes to Anthropic only to be rejected.
  if (Math.floor((imageBase64.length * 3) / 4) > MAX_IMAGE_BYTES) {
    throw new Error('That photo is too large. Try again — the camera should shrink it for you.');
  }
  if (!categoryKeys?.length) throw new Error('No categories are set up to file items under.');

  const response = await doFetch(API_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': API_VERSION,
      // Lets Anthropic re-run a declined request on a fallback model rather
      // than handing us back a refusal.
      'anthropic-beta': 'server-side-fallback-2026-07-01',
    },
    // Reading a dense till slip is slower than writing a paragraph about one,
    // so this is twice the timeout the M5 explanation uses.
    signal: opts.signal ?? AbortSignal.timeout(60_000),
    body: JSON.stringify({
      model: RECEIPT_MODEL,
      // Covers thinking AND the JSON. Thinking is on by default on this model,
      // so a budget sized for the items alone would truncate the reply.
      max_tokens: 8192,
      output_config: {
        // Transcription is careful work rather than deep reasoning, and low/
        // medium effort is strong on this model — this is the cost lever.
        effort: 'medium',
        format: { type: 'json_schema', schema: receiptSchema(categoryKeys) },
      },
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: [
            // Image before text: the instruction reads as being about the photo
            // above it, which is how the vision examples are shaped.
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
            { type: 'text', text: 'Read this receipt.' },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    // Never surface the body verbatim — it can echo request content.
    const retryable = response.status === 429 || response.status >= 500;
    throw new Error(
      retryable
        ? `Claude is busy (HTTP ${response.status}). Try that photo again in a moment.`
        : `Claude could not read that photo (HTTP ${response.status}).`
    );
  }

  const data = await response.json();

  // A 200 does not mean there is JSON to read: safety classifiers decline with
  // stop_reason "refusal" and an empty content array.
  if (data.stop_reason === 'refusal') {
    throw new Error('Claude declined to read that image.');
  }
  // Structured output that hit the cap is truncated JSON, so it would fail to
  // parse below with a far less useful message than this one.
  if (data.stop_reason === 'max_tokens') {
    throw new Error('That receipt was too long to read in one go. Try photographing it in halves.');
  }

  const text = (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (!text) throw new Error('Claude returned nothing for that photo.');

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Claude returned something unreadable for that photo.');
  }

  return { ...sanitise(parsed, categoryKeys), model: data.model ?? RECEIPT_MODEL };
}
