/**
 * Local receipt reading — turns the text of a till slip into line items with
 * no model, no API key and no network call.
 *
 * The heavy lifting (pixels → characters) happens on the phone: Tesseract,
 * compiled to WebAssembly, runs in the browser (public/js/receipt-scan.js) and
 * posts back the lines it read. This module is the other half — the rules that
 * know what a South African till slip looks like:
 *
 *   MELROSE CHDR 900G          129.99 A
 *   2 @ 24.99                   49.98
 *   XTRA SAVINGS               -10.00
 *   TOTAL                      169.97
 *
 * and the matcher that maps "CHKN BRST FLLT" onto the "Chicken breasts" already
 * in your catalog, so the category comes from your own history rather than a
 * guess. Every correction you make in the review form is remembered as an alias
 * (item_alias), so the same abbreviation reads perfectly the next time.
 *
 * Like src/lib/receipt.js this writes nothing. It returns the same proposal
 * shape `sanitise()` does, and the user reviews it before anything is saved.
 */

/** A slip with more lines than this is not a grocery run — it is OCR noise. */
const MAX_ITEMS = 120;
const MAX_QTY = 99;
const MAX_LINE_CENTS = 1_000_000;

/** Below this Tesseract line confidence, a row is flagged for a second look. */
const LOW_OCR_CONFIDENCE = 70;

/** How close a catalog name has to be before it is trusted as the same product. */
const MATCH_THRESHOLD = 0.72;

/**
 * A price at the end of a line: "24.99", "24,99", "R24.99", "24.99A", "5.00-".
 * SA tills print a VAT flag (A, *, #, V, Z) after taxable lines, and some print
 * a discount as a trailing minus.
 *
 * Case-sensitive on purpose: the flag set is A/V/Z/T/*, so a size such as
 * "COKE 2.25L" or "MINCE 1.5KG" is never mistaken for a price.
 */
const PRICE_AT_END = /(-)?\s*[Rr]?\s*(\d{1,5})\s?[.,]\s?(\d{2})\s*(-)?\s*[AVZT*#]{0,2}\s*$/;

/** "2 @ 24.99", "2 x R24.99", "3*12.50" — a quantity and a unit price. */
const QTY_AT = /^(\d{1,3}(?:[.,]\d+)?)\s*(?:@|x|\*)\s*R?\s*(\d{1,5}[.,]\d{2})\b/i;

/** "0.746 kg @ 89.99/kg" — a weighed line. */
const WEIGHED = /(\d+[.,]\d+)\s*kg\s*(?:@|x)\s*R?\s*(\d{1,5}[.,]\d{2})/i;

/** "2 x MILK 2L 49.98" — a quantity prefixed onto the item line itself. */
const QTY_PREFIX = /^(\d{1,2})\s*[x@*]\s+(.+)$/i;

/** The line that ends the items. Everything after it is payment and change. */
const TOTAL_LINE =
  /^(?:grand\s+)?total\b|\b(?:total\s+(?:due|incl\w*|amount|payable)|amount\s+due|balance\s+due|to\s+pay)\b/i;

/** Lines that carry a price but are not a product. */
const NOT_A_PRODUCT =
  /\b(sub\s*-?\s*total|vat|tax|change|cash|card|tender(ed)?|rounding|balance|visa|master\s*card|debit|credit|auth\w*|approved|points?|tip|deposit|refund|items?\s+sold|no\.?\s+of\s+items|qty\s+total)\b/i;

/**
 * A price applied to the line above: loyalty and promo savings. Most tills
 * print these negative anyway; the words catch the ones that do not. "Xtra"
 * alone is not enough — XTRA LARGE EGGS is a product, XTRA SAVINGS is not.
 */
const DISCOUNT =
  /\b(discount|savings?|promo\w*|coupon|instant\s+money|xtra\s*sav\w*|smart\s*shopper|markdown|you\s+saved?)\b/i;

/** "TOTAL SAVINGS", "TOTAL VAT", "SUBTOTAL" — summary lines that are not THE total. */
const SUMMARY_LINE =
  /^\s*sub\s*-?\s*total|^\s*total\b.*\b(sav\w*|disc\w*|items?|qty|vat|tax|excl\w*|points?)\b/i;

/** Header/footer lines with no price that must never become a pending name. */
const BOILERPLATE =
  /\b(tel|fax|reg(istration)?|vat\s*no|till|cashier|operator|slip|receipt|invoice|thank|welcome|www|co\.za|store\s*no|branch|customer|copy|date|time)\b/i;

/** Retailers, longest/most specific first. Matched against the whole slip. */
const RETAILERS = [
  ['Pick n Pay', /pick\s*n\s*pay|\bpnp\b/i],
  ['Checkers', /checkers/i],
  ['Shoprite', /shoprite/i],
  ['Spar', /\bspar\b/i],
  ['Woolworths', /woolworths|\bwoolies\b/i],
  ["Food Lover's Market", /food\s*lover/i],
  ['Makro', /\bmakro\b/i],
  ['Boxer', /\bboxer\b/i],
  ['Usave', /\busave\b/i],
  ['OK Foods', /\bok\s*(foods|minimark|grocer)/i],
  ['Clicks', /\bclicks\b/i],
  ['Dis-Chem', /dis-?\s?chem/i],
];

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * Keyword fallback for a product that is not in the catalog yet. Order matters:
 * "frozen peas" must reach frozen before produce sees "peas", and "peanut
 * butter" must reach pantry before dairy sees "butter".
 */
const CATEGORY_HINTS = [
  ['frozen', /\b(frozen|froz|ice\s*cream|iqf)\b/],
  ['canned', /\b(tin|tinned|canned|can|baked\s*beans|chakalaka|pilchard\w*|koo)\b/],
  ['supplements', /\b(vitamin\w*|vit|protein|whey|creatine|supplement\w*|omega|multivit\w*)\b/],
  [
    'water',
    /\b(water|aqua|still|sparkling|coke|cola|fanta|sprite|juice|cooldrink|soda|energade|powerade)\b/,
  ],
  [
    'toiletries',
    /\b(soap|shampoo|conditioner|toothpaste|toothbrush|deo\w*|lotion|roll\s*on|razor|pads?|tampons?|body\s*wash|vaseline|colgate|dove)\b/,
  ],
  [
    'household',
    /\b(toilet\s*paper|loo\s*roll|tissue\w*|bleach|detergent|dishwash\w*|sunlight|handy\s*andy|foil|cling\w*|refuse|bin\s*bags?|sponge\w*|jik|domestos|omo|sta\s*soft|candles?|matches|batter(y|ies))\b/,
  ],
  [
    'snacks',
    /\b(chips|crisps|chocolate|choc|biscuit\w*|cookies?|sweets|candy|popcorn|simba|lays|doritos|nuts|rusks?|bar)\b/,
  ],
  [
    'spices_condiments',
    /\b(salt|spice\w*|sauce|ketchup|tomato\s*sauce|mayo\w*|mustard|vinegar|paprika|curry|stock|aromat|chutney|peri\s*peri|herbs?|cinnamon|cumin|seasoning)\b/,
  ],
  [
    'pantry',
    /\b(oil|sugar|tea|rooibos|coffee|beans|lentils?|peanut\s*butter|jam|honey|flour|syrup|cocoa|soup|custard|jelly)\b/,
  ],
  [
    'meat_seafood',
    /\b(chicken|chkn|beef|mince|pork|lamb|fish|hake|wors|boerewors|sausages?|bacon|steak|salmon|prawns?|polony|viennas?|drumsticks?|thighs?|wings?|fillets?|braai)\b/,
  ],
  [
    'dairy_eggs',
    /\b(milk|cheese|chdr|cheddar|gouda|yoghurt|yogurt|yog|butter|eggs?|cream|marg\w*|amasi|maas|feta)\b/,
  ],
  [
    'bread_grains',
    /\b(bread|rolls?|buns?|rice|pasta|spaghetti|macaroni|oats|maize|mealie\w*|wraps?|tortilla\w*|noodles?|cereal|cornflakes|weet\w*|pap|samp)\b/,
  ],
  [
    'produce',
    /\b(apples?|bananas?|tomato\w*|onions?|potato\w*|spinach|peppers?|carrots?|lettuce|avo\w*|lemons?|garlic|ginger|cabbage|broccoli|cucumbers?|fruit|veg\w*|mushroom\w*|oranges?|grapes?|butternut|pumpkin|peas|corn|beetroot|herbs|naartjies?|pears?)\b/,
  ],
];

// ---------------------------------------------------------------------------
// text helpers
// ---------------------------------------------------------------------------

const cents = (whole, frac) => Number(whole) * 100 + Number(frac);

/**
 * Undo the classic OCR digit confusions, but only inside a token that is
 * already mostly a number — "M1LK" must stay a word, "24.O9" must become 24.09.
 */
function fixDigits(line) {
  return line.replace(/[\dOoIl|SB][\dOoIl|SB.,]*[\dOoIl|SB]/g, (token) => {
    const digits = (token.match(/\d/g) || []).length;
    const letters = token.replace(/[\d.,]/g, '').length;
    if (digits < 2 || letters > digits / 2 || !/[.,]/.test(token)) return token;
    return token.replace(/[Oo]/g, '0').replace(/[Il|]/g, '1').replace(/S/g, '5').replace(/B/g, '8');
  });
}

/** Lowercase, drop sizes and pack counts, keep only words. */
export function normaliseName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:kg|g|gr|ml|l|lt|ltr|litre|s|pk|pack|x\d+|'s)\b/g, ' ')
    .replace(/\bx\s*\d+\b/g, ' ')
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Crude singular, so "eggs" meets "egg" and "breasts" meets "breast". */
const singular = (token) =>
  token.length > 3 && token.endsWith('s') && !token.endsWith('ss') ? token.slice(0, -1) : token;

const tokensOf = (value) =>
  normaliseName(value)
    .split(' ')
    .filter((t) => t.length > 1)
    .map(singular);

function bigrams(word) {
  const grams = new Set();
  for (let i = 0; i < word.length - 1; i += 1) grams.add(word.slice(i, i + 2));
  return grams;
}

function dice(a, b) {
  if (a === b) return 1;
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (!ga.size || !gb.size) return 0;
  let shared = 0;
  for (const g of ga) if (gb.has(g)) shared += 1;
  return (2 * shared) / (ga.size + gb.size);
}

/**
 * Is `short` a till abbreviation of `long`? Tills drop vowels and truncate:
 * CHKN → chicken, BRST → breast, CHDR → cheddar. Same first letter, and every
 * letter of the short form appears in order in the long one.
 */
function isAbbreviation(short, long) {
  if (short.length < 2 || short.length >= long.length || short[0] !== long[0]) return false;
  let j = 0;
  for (const ch of long) if (ch === short[j]) j += 1;
  return j === short.length;
}

function tokenScore(a, b) {
  if (a === b) return 1;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.92;
  if (isAbbreviation(a, b) || isAbbreviation(b, a)) return 0.85;
  return dice(a, b);
}

/**
 * How well a line from the slip names a catalog item, 0–1.
 *
 * Every word of the *catalog* name has to be found on the slip — "Maize meal"
 * matches "WHITE STAR MAIZE MEAL 2.5KG" fully, because the brand is noise. A
 * small penalty for unmatched slip words stops "Milk" from claiming
 * "MILK CHOCOLATE SLAB" outright.
 */
export function nameScore(slipName, catalogName) {
  const slip = tokensOf(slipName);
  const known = tokensOf(catalogName);
  if (!slip.length || !known.length) return 0;

  const used = new Set();
  let total = 0;
  for (const k of known) {
    let best = 0;
    let bestIdx = -1;
    slip.forEach((s, idx) => {
      const score = tokenScore(s, k);
      if (score > best) {
        best = score;
        bestIdx = idx;
      }
    });
    total += best;
    if (best >= 0.7) used.add(bestIdx);
  }
  const coverage = total / known.length;
  const slipCoverage = used.size / slip.length;
  return coverage * (0.8 + 0.2 * slipCoverage);
}

/**
 * The catalog item a slip line most likely is, or null.
 *
 * @param {string} slipName
 * @param {Array<{id:number,name:string,category_key:string}>} catalog
 * @param {Map<string, object>} aliases normalised slip text -> catalog item
 */
export function matchCatalog(slipName, catalog, aliases = new Map()) {
  const key = normaliseName(slipName);
  if (key && aliases.has(key)) return { item: aliases.get(key), score: 1, via: 'alias' };

  let best = null;
  for (const item of catalog) {
    const score = nameScore(slipName, item.name);
    // Ties go to the longer name: "Chicken breasts" over "Chicken".
    if (
      score >= MATCH_THRESHOLD &&
      (!best ||
        score > best.score + 1e-9 ||
        (Math.abs(score - best.score) < 1e-9 && item.name.length > best.item.name.length))
    ) {
      best = { item, score, via: 'catalog' };
    }
  }
  return best;
}

/** Best-effort category for a product the catalog has never seen. */
export function guessCategory(name, categoryKeys) {
  const allowed = new Set(categoryKeys);
  const text = ` ${String(name).toLowerCase()} `;
  for (const [key, pattern] of CATEGORY_HINTS) {
    if (allowed.has(key) && pattern.test(text)) return key;
  }
  return allowed.has('pantry') ? 'pantry' : categoryKeys[0];
}

/** "MELROSE CHDR 900G" -> "Melrose Chdr 900g": readable, without pretending to expand it. */
function tidyName(value) {
  return value
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** The transaction date, as YYYY-MM-DD, or null. SA slips print day first. */
export function findDate(text) {
  const valid = (y, m, d) => {
    const year = y < 100 ? 2000 + y : y;
    if (year < 2000 || year > 2099 || m < 1 || m > 12 || d < 1 || d > 31) return null;
    const iso = `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const parsed = new Date(`${iso}T00:00:00Z`);
    return parsed.getUTCDate() === d ? iso : null;
  };

  const patterns = [
    [/\b(20\d{2})[/.-](\d{1,2})[/.-](\d{1,2})\b/, (m) => valid(+m[1], +m[2], +m[3])],
    [/\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})\b/, (m) => valid(+m[3], +m[2], +m[1])],
    [
      /\b(\d{1,2})\s*[-/ ]?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s*[-/ ]?\s*(\d{4}|\d{2})\b/i,
      (m) => valid(+m[3], MONTHS.indexOf(m[2].toLowerCase().slice(0, 3)) + 1, +m[1]),
    ],
  ];
  for (const line of String(text).split('\n')) {
    for (const [pattern, toIso] of patterns) {
      const match = pattern.exec(line);
      const iso = match && toIso(match);
      if (iso) return iso;
    }
  }
  return null;
}

/** The retailer named on the slip, or null. */
export function findStore(text) {
  for (const [name, pattern] of RETAILERS) if (pattern.test(text)) return name;
  return null;
}

// ---------------------------------------------------------------------------
// the line walker
// ---------------------------------------------------------------------------

/** Accept either raw text or Tesseract's `[{text, conf}]` lines. */
function toLines(input) {
  const raw = Array.isArray(input)
    ? input
    : String(input ?? '')
        .split(/\r?\n/)
        .map((text) => ({ text, conf: null }));
  return raw
    .map((line) => ({
      text: fixDigits(
        String(line?.text ?? '')
          .replace(/\s+/g, ' ')
          .trim()
      ),
      // typeof, not Number(): Number(null) is 0, which would read a slip with
      // no confidences at all as one the OCR was 0% sure of.
      conf: typeof line?.conf === 'number' && Number.isFinite(line.conf) ? line.conf : null,
    }))
    .filter((line) => line.text.length > 1);
}

/** Split "NAME ... 24.99A" into its name and amount in cents (negative for a discount). */
function splitPrice(text) {
  const match = PRICE_AT_END.exec(text);
  if (!match) return null;
  const amount = cents(match[2], match[3]);
  const negative = Boolean(match[1] || match[4]);
  return { name: text.slice(0, match.index).trim(), cents: negative ? -amount : amount };
}

/** Strip a leading barcode / PLU and stray punctuation from an item name. */
const cleanName = (name) =>
  name
    .replace(/^\d{4,}\s*/, '')
    .replace(/^[^A-Za-z]+/, '')
    .replace(/[^A-Za-z0-9)%]+$/, '')
    .trim();

const hasWord = (text) => /[A-Za-z]{2,}/.test(text);

/**
 * Walk the slip top to bottom and pull out the purchased lines.
 *
 * @returns {{items: Array<{raw:string, qty:number, unitCents:number|null,
 *   lineCents:number|null, conf:number|null}>, totalCents:number|null, dropped:number}}
 */
export function extractLines(input) {
  const lines = toLines(input);
  const items = [];
  let totalCents = null;
  let pending = null; // a name line still waiting for its price
  let dropped = 0;
  let previousWasItem = false;

  const push = (raw, lineCents, conf, qty = 1, unitCents = null) => {
    const name = cleanName(raw);
    if (!hasWord(name)) {
      dropped += 1;
      return;
    }
    items.push({ raw: name, qty, unitCents, lineCents, conf });
    previousWasItem = true;
  };

  for (const { text, conf } of lines) {
    // Summary lines are skipped outright: "TOTAL SAVINGS 25.00" must neither
    // end the slip nor come off the last item as a discount.
    if (SUMMARY_LINE.test(text)) {
      pending = null;
      previousWasItem = false;
      continue;
    }

    // The items are over once the total is printed.
    if (TOTAL_LINE.test(text)) {
      const priced = splitPrice(text);
      if (priced && priced.cents > 0) {
        totalCents = priced.cents;
        break;
      }
      continue;
    }

    const weighed = WEIGHED.exec(text);
    const qtyAt = weighed ? null : QTY_AT.exec(text);
    if (weighed || qtyAt) {
      // A modifier line. It belongs to the name printed just above it, which
      // either has no price yet (pending) or was the last item pushed.
      const priced = splitPrice(
        text.slice((weighed || qtyAt).index + (weighed || qtyAt)[0].length)
      );
      const unit = cents(...(weighed || qtyAt)[2].split(/[.,]/));
      const qty = weighed ? 1 : Math.min(Number(qtyAt[1].replace(',', '.')) || 1, MAX_QTY);
      const kg = weighed ? Number(weighed[1].replace(',', '.')) : null;
      const lineCents = priced?.cents > 0 ? priced.cents : Math.round(kg ? kg * unit : qty * unit);

      if (pending) {
        push(pending.text, lineCents, pending.conf, qty, weighed ? lineCents : unit);
        pending = null;
      } else if (previousWasItem && items.length) {
        const last = items[items.length - 1];
        last.qty = qty;
        last.unitCents = weighed ? (last.lineCents ?? lineCents) : unit;
        if (last.lineCents === null) last.lineCents = lineCents;
      }
      continue;
    }

    const priced = splitPrice(text);
    if (!priced) {
      // A name with no price: hold it for the next line, which on many tills
      // carries the quantity and amount.
      pending =
        hasWord(text) && !BOILERPLATE.test(text) && !NOT_A_PRODUCT.test(text)
          ? { text, conf }
          : null;
      previousWasItem = false;
      continue;
    }

    if (DISCOUNT.test(text) || priced.cents < 0) {
      // A saving belongs to the line above it, not the basket as a whole.
      const last = previousWasItem ? items[items.length - 1] : null;
      if (last && last.lineCents !== null) {
        last.lineCents = Math.max(0, last.lineCents - Math.abs(priced.cents));
        last.unitCents = Math.round(last.lineCents / (Number.isInteger(last.qty) ? last.qty : 1));
        last.discounted = true;
      }
      pending = null;
      continue;
    }

    if (NOT_A_PRODUCT.test(text) || BOILERPLATE.test(priced.name)) {
      pending = null;
      previousWasItem = false;
      continue;
    }

    let name = priced.name;
    let qty = 1;
    const prefixed = QTY_PREFIX.exec(name);
    if (prefixed) {
      qty = Math.min(Number(prefixed[1]), MAX_QTY);
      name = prefixed[2];
    }

    if (!hasWord(name) && pending) {
      // "MILK 2L" on one line, "24.99" alone on the next.
      push(pending.text, priced.cents, pending.conf);
    } else {
      push(name, priced.cents, conf, qty, qty > 1 ? Math.round(priced.cents / qty) : null);
    }
    pending = null;
  }

  return {
    items: items.slice(0, MAX_ITEMS),
    totalCents,
    dropped: dropped + Math.max(0, items.length - MAX_ITEMS),
  };
}

// ---------------------------------------------------------------------------
// the whole slip
// ---------------------------------------------------------------------------

const saneCents = (n) => (Number.isInteger(n) && n > 0 && n <= MAX_LINE_CENTS ? n : null);

/**
 * Read a slip's text into a reviewable proposal.
 *
 * @param {string | Array<{text:string, conf?:number}>} input OCR output
 * @param {{catalog: Array<{id,name,category_key}>, categoryKeys: string[],
 *   aliases?: Map<string, object>}} context
 * @returns {{store, purchasedOn, totalCents, items, dropped, linesCents, engine}}
 */
export function readReceiptText(input, { catalog = [], categoryKeys, aliases = new Map() }) {
  const text = Array.isArray(input)
    ? input.map((l) => l?.text ?? '').join('\n')
    : String(input ?? '');
  const { items: lines, totalCents, dropped } = extractLines(input);

  const items = lines.map((line) => {
    const match = matchCatalog(line.raw, catalog, aliases);
    const lineTotalCents = saneCents(line.lineCents);
    const qty = Number.isFinite(line.qty) && line.qty > 0 ? Math.min(line.qty, MAX_QTY) : 1;
    const unitPriceCents =
      saneCents(line.unitCents) ??
      (lineTotalCents !== null
        ? Math.round(lineTotalCents / (Number.isInteger(qty) ? qty : 1))
        : null);

    // A row earns "confident" only when nothing about it needed interpreting:
    // the OCR was sure of the characters, it is a product you have bought
    // before, and the quantity times the price agrees with the line total.
    const arithmeticOk =
      lineTotalCents === null ||
      unitPriceCents === null ||
      !Number.isInteger(qty) ||
      Math.abs(unitPriceCents * qty - lineTotalCents) <= qty;
    const ocrOk = line.conf === null || line.conf >= LOW_OCR_CONFIDENCE;

    return {
      name: match ? match.item.name : tidyName(line.raw),
      raw: line.raw,
      qty,
      unitPriceCents,
      lineTotalCents,
      categoryKey: match ? match.item.category_key : guessCategory(line.raw, categoryKeys),
      confident: Boolean(match) && ocrOk && arithmeticOk,
      matched: match ? match.via : null,
    };
  });

  const linesCents = items.reduce((sum, item) => sum + (item.lineTotalCents ?? 0), 0);

  return {
    store: findStore(text),
    purchasedOn: findDate(text),
    totalCents: saneCents(totalCents),
    items,
    dropped,
    linesCents,
    engine: 'local',
  };
}

// ---------------------------------------------------------------------------
// QR codes
// ---------------------------------------------------------------------------

/**
 * Make sense of whatever a receipt's QR code held.
 *
 * South Africa has no fiscal-receipt QR standard (unlike, say, Portugal or
 * Brazil, where the code carries the whole invoice), so on a local slip a QR is
 * almost always a link to a survey, an e-receipt page or a transaction
 * reference. Those are reported honestly rather than "read". When a code does
 * carry an itemised list — JSON, or one `name;qty;price` per line — it is used
 * directly, which is more reliable than OCR could ever be.
 *
 * @returns {{kind:'items', lines:Array<{text:string}>}
 *   | {kind:'url', url:string} | {kind:'text', text:string} | null}
 */
export function readQrPayload(payload) {
  const value = String(payload ?? '').trim();
  if (!value) return null;

  if (/^https?:\/\/\S+$/i.test(value)) return { kind: 'url', url: value };

  // JSON: {items:[{name, qty, price}]} or a bare array of the same.
  try {
    const data = JSON.parse(value);
    const rows = Array.isArray(data) ? data : data?.items;
    if (Array.isArray(rows) && rows.length) {
      const lines = rows
        .filter((r) => r && r.name)
        .map((r) => {
          const qty = Number(r.qty ?? r.quantity ?? 1) || 1;
          const price = Number(r.total ?? r.price ?? r.amount);
          const amount = Number.isFinite(price) ? (price * (r.total ? 1 : qty)).toFixed(2) : '';
          return { text: `${qty > 1 ? `${qty} x ` : ''}${r.name} ${amount}`.trim() };
        });
      if (lines.length) return { kind: 'items', lines };
    }
  } catch {
    // not JSON — fall through
  }

  // Delimited rows: "Milk 2L;2;24.99" (also tab or pipe separated).
  const rows = value.split(/\r?\n/).filter(Boolean);
  const delimited = rows
    .map((row) => row.split(/[;|\t]/).map((cell) => cell.trim()))
    .filter(
      (cells) =>
        cells.length >= 2 && hasWord(cells[0]) && /\d[.,]\d{2}$/.test(cells[cells.length - 1])
    );
  if (delimited.length && delimited.length >= rows.length / 2) {
    return {
      kind: 'items',
      lines: delimited.map((cells) => {
        const qty = cells.length >= 3 ? Number(cells[1]) || 1 : 1;
        const unit = cells[cells.length - 1].replace(',', '.');
        const total = (Number(unit) * qty).toFixed(2);
        return { text: `${qty > 1 ? `${qty} x ` : ''}${cells[0]} ${total}` };
      }),
    };
  }

  // Plain text that already looks like a slip.
  if (rows.filter((row) => PRICE_AT_END.test(row) && hasWord(row)).length >= 2) {
    return { kind: 'items', lines: rows.map((text) => ({ text })) };
  }

  return { kind: 'text', text: value.slice(0, 500) };
}
