/**
 * Habit intelligence (M2) — the part of ghrub that tells you about your own
 * shopping instead of just recording it.
 *
 * There is deliberately NO SQL in here. Every number comes from a query on
 * src/db/repo.js; this module owns the thresholds, ratios and cadence maths
 * (docs/05 hard rule: all DB access through repo.js).
 *
 * Money stays integer cents throughout — averages are rounded to whole cents.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** On at least this share of past trips' lists to count as a "regular". */
export const REGULAR_THRESHOLD = 0.5;

/** Listed on at least this many past trips to count as "often forgotten". */
export const FORGOTTEN_MIN_TRIPS = 3;

/**
 * Items that recur on >= `threshold` of your past trips.
 *
 * Counted on **listed**, not bought — a deliberate departure from the sketch
 * SQL in docs/02, which filters `bought = 1`. That filter cannot produce the
 * regulars the same document says to expect: Oats is listed on 6 of 10 trips
 * but bought on only 2, so `bought = 1` drops it, and both docs/02 and the M2
 * DoD name Oats as a regular. Writing an item down is the habit; whether you
 * got it that week (out of stock, over budget) is a different signal, kept
 * alongside as `trips_bought` so the UI can show "6 lists · bought 2".
 *
 * `tripId` is excluded from both the count and the denominator, so a fresh
 * empty trip sees the habits of every *other* trip rather than diluting them
 * with itself. Items already on the list come back too, flagged
 * `already_on_list`, so the UI can grey them instead of silently dropping them.
 */
export function regulars(db, tripId = null, { threshold = REGULAR_THRESHOLD, limit = 20 } = {}) {
  const onList = new Set(tripId ? db.itemIdsOnTrip(tripId) : []);
  return db
    .itemFrequency(tripId)
    .filter((row) => row.total_trips > 0 && row.trips_listed / row.total_trips >= threshold)
    .slice(0, limit)
    .map((row) => ({
      ...row,
      ratio: row.trips_listed / row.total_trips,
      already_on_list: onList.has(row.item_id),
    }));
}

/** Lines on this trip you have never bought before — worth a second look. */
export function newThisList(db, tripId) {
  return db.itemsFirstSeenOnTrip(tripId);
}

/**
 * Things you list often but that are missing from this trip.
 *
 * Regulars are excluded on purpose: a missing regular is already shouted about
 * by its own bucket, and showing it twice makes both cards noise. What is left
 * is the genuinely useful set — frequent enough to matter, not frequent enough
 * to be a regular, and not on the list.
 */
export function oftenForgotten(
  db,
  tripId,
  { minTrips = FORGOTTEN_MIN_TRIPS, limit = 10, threshold = REGULAR_THRESHOLD } = {}
) {
  const onList = new Set(db.itemIdsOnTrip(tripId));
  const isRegular = new Set(
    regulars(db, tripId, { threshold, limit: Infinity }).map((r) => r.item_id)
  );
  return db
    .itemFrequency(tripId)
    .filter(
      (row) =>
        row.trips_listed >= minTrips && !onList.has(row.item_id) && !isRegular.has(row.item_id)
    )
    .slice(0, limit);
}

/**
 * How often you shop, from the gaps between consecutive trips.
 *
 * Median, not mean: the seed history has a 137-day hole between July and
 * December, which drags a mean to ~36 days when the habit is really ~19.
 */
export function cadence(db) {
  const stamps = db
    .tripSpendSummaries()
    .map((t) => t.effective_date)
    .filter(Boolean)
    .map((d) => Date.parse(`${String(d).slice(0, 10)}T00:00:00Z`))
    .filter((ms) => Number.isFinite(ms))
    .sort((a, b) => a - b);

  if (stamps.length < 2) {
    return {
      trips: stamps.length,
      medianGapDays: null,
      lastShopDate: stamps.length ? toISODate(stamps[0]) : null,
      suggestedNextShopDate: null,
    };
  }

  const gaps = [];
  for (let i = 1; i < stamps.length; i += 1) {
    gaps.push(Math.round((stamps[i] - stamps[i - 1]) / DAY_MS));
  }
  const gap = median(gaps);
  const last = stamps[stamps.length - 1];

  return {
    trips: stamps.length,
    medianGapDays: gap,
    lastShopDate: toISODate(last),
    suggestedNextShopDate: toISODate(last + gap * DAY_MS),
  };
}

/** Spend per trip and per category — the numbers behind the /history page. */
export function spendHistory(db) {
  const trips = db.tripSpendSummaries();
  const withSpend = trips.filter((t) => t.total_cents > 0);
  const totalCents = withSpend.reduce((sum, t) => sum + t.total_cents, 0);
  const budgeted = trips.filter((t) => t.budget_cents != null && t.total_cents > 0);

  return {
    trips,
    tripCount: trips.length,
    avgPerTripCents: withSpend.length ? Math.round(totalCents / withSpend.length) : 0,
    totalCents,
    budgetedCount: budgeted.length,
    overBudgetCount: budgeted.filter((t) => t.total_cents > t.budget_cents).length,
    byCategory: db.categorySpendAverages(),
  };
}

/** The three suggestion buckets shown above a trip's list. */
export function insightsForTrip(db, tripId) {
  return {
    regulars: regulars(db, tripId),
    newThisList: newThisList(db, tripId),
    oftenForgotten: oftenForgotten(db, tripId),
    cadence: cadence(db),
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function toISODate(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}
