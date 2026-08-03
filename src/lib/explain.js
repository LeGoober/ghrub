/**
 * "Explain this shop" (M5) — an optional narrative summary of a trip, written
 * by Claude from the numbers ghrub already computed.
 *
 * OFF BY DEFAULT. The whole app works without it: the route 404s unless
 * ENABLE_LLM=true *and* an API key is present, and nothing else imports this
 * module. That is the M5 Definition of Done — "LLM flag off by default and the
 * app fully works without it".
 *
 * Deliberately hand-rolled over Node 20's built-in fetch rather than pulling in
 * @anthropic-ai/sdk. docs/05 forbids new dependencies without justification,
 * and shipping an SDK in every production image for one optional, disabled-by-
 * default call does not clear that bar. It is a single POST to /v1/messages.
 *
 * API details that are easy to get wrong (verified against the claude-api
 * skill, not from memory):
 *  - Thinking is ON by default on Claude Opus 5, and `max_tokens` caps thinking
 *    *plus* response text. A budget sized for a 120-word answer would truncate
 *    mid-sentence, so the cap is generous and `effort` is what keeps it cheap.
 *  - `temperature` / `top_p` / `top_k` are rejected with a 400 on this model.
 *    Voice is steered by the system prompt instead.
 *  - A safety classifier can decline with HTTP 200 + stop_reason "refusal", so
 *    stop_reason is checked before reading content.
 */

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Latest Claude model, per docs/03 ("Optional 'Explain this shop' via latest Claude model"). */
export const EXPLAIN_MODEL = 'claude-opus-5';

const SYSTEM_PROMPT = `You are the voice of ghrub, a personal grocery app whose tagline is "Your groceries, remembered."

You will be given the facts ghrub has already worked out about one shopping trip. Write the user a short read of their shop.

Rules:
- 3 to 5 sentences. No headings, no bullet points, no preamble.
- Second person, plain and warm. You are a friend who noticed something, not a report.
- Use ONLY the facts given. Never invent an item, a price, or a trend. If a fact is missing, say nothing about it rather than guessing.
- Money is South African Rand, already formatted as given — copy the strings verbatim.
- Lead with whatever is most useful to them, not with a recap of the list.
- No emoji.`;

/**
 * Whether the feature is switched on. Requires BOTH the flag and a key —
 * ENABLE_LLM=true with no key would otherwise fail at request time instead of
 * being cleanly unavailable.
 */
export function llmEnabled(env = process.env) {
  return String(env.ENABLE_LLM ?? '').toLowerCase() === 'true' && Boolean(env.ANTHROPIC_API_KEY);
}

/**
 * Flatten what ghrub knows about a trip into the fact sheet the model gets.
 * Pure string building — no network, no SQL — so it is testable on its own and
 * so it is obvious exactly what leaves the machine.
 */
export function buildFactSheet({ trip, budget, buckets, cadence, comparison, formatCents }) {
  const lines = [`Trip: ${trip.name}`];

  if (trip.start_date || trip.end_date) {
    lines.push(`Period: ${trip.start_date || '?'} to ${trip.end_date || '?'}`);
  }
  if (trip.shop_date) lines.push(`Shopping on: ${trip.shop_date}`);

  lines.push(`Lines on the list: ${budget.lineCount} (${budget.boughtCount} already ticked off)`);
  lines.push(`Running total: ${formatCents(budget.subtotalCents)}`);

  if (budget.budgetCents != null) {
    const state =
      budget.state === 'over'
        ? 'over budget'
        : budget.state === 'near'
          ? 'close to the limit'
          : 'comfortably within budget';
    lines.push(`Budget: ${formatCents(budget.budgetCents)} — ${state}`);
  } else {
    lines.push('Budget: none set for this trip');
  }

  if (budget.byCategory.length) {
    const top = budget.byCategory
      .slice()
      .sort((a, b) => b.subtotal_cents - a.subtotal_cents)
      .slice(0, 3)
      .map((c) => `${c.category_label} ${formatCents(c.subtotal_cents)}`);
    lines.push(`Biggest categories: ${top.join(', ')}`);
  }

  for (const bucket of buckets) {
    if (!bucket.rows.length) continue;
    const names = bucket.rows.slice(0, 6).map((r) => r.name);
    lines.push(`${bucket.title}: ${names.join(', ')}`);
  }

  if (cadence.medianGapDays) {
    lines.push(
      `Shopping rhythm: about every ${cadence.medianGapDays} days; last shop ${cadence.lastShopDate}, next due around ${cadence.suggestedNextShopDate}`
    );
  }

  if (comparison?.hasPrices && comparison.cheapest && !comparison.cheapest.tied) {
    const saving = comparison.cheapest.savingVsNextCents;
    lines.push(
      `Cheapest store for this basket: ${comparison.cheapest.storeName}` +
        (saving ? `, by ${formatCents(saving)}` : '') +
        ` (compared on ${comparison.comparableLineCount} of ${comparison.totalLineCount} lines priced everywhere)`
    );
  }

  return lines.join('\n');
}

/**
 * Ask Claude to read the shop.
 *
 * @param {string} factSheet from buildFactSheet
 * @param {{env?: object, fetchImpl?: Function, signal?: AbortSignal}} [opts]
 *   `fetchImpl` is injectable so the tests never touch the network.
 * @returns {Promise<{text: string, model: string}>}
 */
export async function requestExplanation(factSheet, opts = {}) {
  const env = opts.env ?? process.env;
  const doFetch = opts.fetchImpl ?? globalThis.fetch;

  if (!llmEnabled(env)) throw new Error('LLM is disabled');

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
    // A grocery summary is not worth a long wait; fail fast and let the user retry.
    signal: opts.signal ?? AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model: EXPLAIN_MODEL,
      // Covers thinking AND the answer — thinking is on by default on this
      // model, so a budget sized for the prose alone would truncate it.
      max_tokens: 4096,
      // The cheap lever. Reading a fact sheet does not need deep reasoning,
      // and effort — not temperature — is how spend is tuned here.
      output_config: { effort: 'low' },
      fallbacks: 'default',
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: factSheet }],
    }),
  });

  if (!response.ok) {
    // Never surface the body verbatim — it can echo request content.
    const retryable = response.status === 429 || response.status >= 500;
    throw new Error(
      retryable
        ? `Claude is busy (HTTP ${response.status}). Try again in a moment.`
        : `Claude rejected the request (HTTP ${response.status}).`
    );
  }

  const data = await response.json();

  // A 200 does not mean there is prose to read: safety classifiers decline
  // with stop_reason "refusal" and an empty content array.
  if (data.stop_reason === 'refusal') {
    throw new Error('Claude declined to summarise this trip.');
  }

  const text = (data.content ?? [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (!text) throw new Error('Claude returned an empty summary.');
  return { text, model: data.model ?? EXPLAIN_MODEL };
}
