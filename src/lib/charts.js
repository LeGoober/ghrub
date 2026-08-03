/**
 * Chart geometry for the /history dashboard (M2).
 *
 * Pure maths — no SQL, no HTML. Each function turns rows into plain
 * coordinates so the EJS views can draw inline SVG (no chart library, nothing
 * fetched at runtime) and so the layout is unit-testable.
 *
 * Design decisions come from the `dataviz` skill and were validated, not
 * eyeballed:
 *
 * - **One hue per chart.** Trips and categories are nominal, so shading them
 *   light-to-dark would double-encode bar length as colour and burn the only
 *   free channel. Every bar is the same mark colour.
 * - **The palette is validated.** `#12855a` passes the lightness band, chroma
 *   floor and 3:1 contrast checks; ghrub's own `--accent` (#1f6f4a) fails the
 *   chroma floor for chart marks ("reads gray"), so charts use the brighter
 *   step of the same green.
 * - **Over-budget is not colour-alone.** Green vs red is ΔE 1.7 under
 *   protanopia — invisible. So the overshoot is a *separate stacked segment*
 *   carrying an "over" label: the split and the word are the signal, and the
 *   colour only reinforces them. The 2px surface gap between segments is what
 *   separates them — never a stroke.
 * - Bars cap at 24px and the band's leftover is air; data-ends are 4px rounded
 *   and square at the baseline; gridlines are solid hairlines.
 */

import { formatCents } from './money.js';

const MAX_BAR = 24; // px — cap the mark, let the rest of the band breathe
const GAP = 2; // px — the surface gap between stacked segments
const RADIUS = 4; // px — rounded data-end

/**
 * Spend per trip, chronological columns.
 *
 * A trip that broke its budget is drawn as two stacked segments split at the
 * budget: everything up to budget in the mark colour, the overshoot above it in
 * the status colour. A trip that stayed under gets a hairline budget tick above
 * its column instead, so "how close did I get" is readable either way.
 */
export function spendPerTripChart(trips, { width = 680, height = 260 } = {}) {
  const pad = { top: 18, right: 12, bottom: 42, left: 52 };
  const plot = {
    x: pad.left,
    y: pad.top,
    w: width - pad.left - pad.right,
    h: height - pad.top - pad.bottom,
  };
  const baseline = plot.y + plot.h;

  const rows = trips.filter((t) => t.total_cents > 0);
  const peak = Math.max(
    1,
    ...rows.map((t) => Math.max(t.total_cents, t.budget_cents == null ? 0 : t.budget_cents))
  );
  const ticks = niceTicks(peak);
  const top = ticks[ticks.length - 1];
  const scale = (cents) => (cents / top) * plot.h;

  const band = rows.length ? plot.w / rows.length : plot.w;
  const barW = Math.min(MAX_BAR, band * 0.6);

  const bars = rows.map((trip, i) => {
    const x = plot.x + band * i + (band - barW) / 2;
    const total = scale(trip.total_cents);
    const isOver = trip.budget_cents != null && trip.total_cents > trip.budget_cents;
    // Where the budget sits on this column: the split point when the trip went
    // over, the tick position when it did not.
    const budgetY = trip.budget_cents == null ? null : baseline - scale(trip.budget_cents);

    const segments = [];
    const overH = isOver ? budgetY - GAP - (baseline - total) : 0;

    if (isOver && overH >= 1) {
      segments.push({ kind: 'within', path: barPath(x, budgetY, barW, baseline - budgetY, false) });
      segments.push({ kind: 'over', path: barPath(x, baseline - total, barW, overH, true) });
    } else if (isOver) {
      // Squeaked over: the overshoot is under a pixel once the surface gap is
      // taken out. Splitting here would drop the sliver and draw a column
      // shorter than the trip actually cost, so keep one full-height segment
      // and let it carry the over-budget colour.
      segments.push({ kind: 'over', path: barPath(x, baseline - total, barW, total, true) });
    } else {
      segments.push({ kind: 'within', path: barPath(x, baseline - total, barW, total, true) });
    }

    const overBy = isOver ? trip.total_cents - trip.budget_cents : null;
    return {
      id: trip.id,
      name: trip.name,
      x,
      w: barW,
      centerX: x + barW / 2,
      topY: baseline - total,
      segments,
      isOver,
      budgetY: isOver ? null : budgetY,
      budgetTickX1: x - 3,
      budgetTickX2: x + barW + 3,
      overBy,
      // A flag, not a value. "over R139.52" renders ~72px wide while the bands
      // are only ~68px apart, so amounts would collide on consecutive
      // over-budget trips. The word alone always fits, and it is what makes
      // the state readable without relying on the red — the amount is in the
      // hover title and, ungated, in the table below the chart.
      label: isOver ? 'over' : null,
      axisLabel: shortDate(trip.effective_date),
      title: tripTitle(trip, overBy),
    };
  });

  return {
    width,
    height,
    plot,
    baseline,
    bars,
    empty: rows.length === 0,
    yTicks: ticks.map((cents) => ({
      y: baseline - scale(cents),
      label: formatCents(cents),
    })),
  };
}

/**
 * Average spend per category, sorted high to low.
 *
 * Horizontal because the category names are long ("Spices and Condiments"), and
 * with the value direct-labelled at each tip there is nothing left for an
 * x-axis to say — so it does not get one.
 */
export function categorySpendChart(categories, { width = 680, rowHeight = 28 } = {}) {
  const pad = { top: 6, right: 74, bottom: 6, left: 168 };
  const rows = categories.filter((c) => c.avg_cents > 0);
  const height = pad.top + pad.bottom + rows.length * rowHeight;
  const plotW = width - pad.left - pad.right;
  const peak = Math.max(1, ...rows.map((c) => c.avg_cents));
  const barH = Math.min(MAX_BAR, rowHeight - 8);

  return {
    width,
    height,
    empty: rows.length === 0,
    labelX: pad.left - 10,
    rows: rows.map((cat, i) => {
      const w = (cat.avg_cents / peak) * plotW;
      const y = pad.top + i * rowHeight + (rowHeight - barH) / 2;
      return {
        label: cat.category_label,
        value: formatCents(cat.avg_cents),
        y,
        h: barH,
        textY: y + barH / 2,
        x: pad.left,
        w,
        valueX: pad.left + w + 8,
        title: `${cat.category_label}: ${formatCents(cat.avg_cents)} average across ${cat.trips_with_category} trips`,
      };
    }),
  };
}

/** Column path: rounded at the data-end, square at the baseline. */
function barPath(x, y, w, h, roundTop) {
  const height = Math.max(0, h);
  if (height === 0) return '';
  const r = roundTop ? Math.min(RADIUS, w / 2, height) : 0;
  if (r === 0) return `M${x} ${y}h${w}v${height}h${-w}Z`;
  return [
    `M${x} ${y + height}`,
    `L${x} ${y + r}`,
    `Q${x} ${y} ${x + r} ${y}`,
    `L${x + w - r} ${y}`,
    `Q${x + w} ${y} ${x + w} ${y + r}`,
    `L${x + w} ${y + height}`,
    'Z',
  ].join(' ');
}

/** Axis ticks on clean 1/2/5 × 10ⁿ boundaries, always including 0. */
function niceTicks(peak, count = 4) {
  const mag = 10 ** Math.floor(Math.log10(peak / count));
  const norm = peak / count / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = 0; v < peak + step; v += step) ticks.push(v);
  return ticks;
}

function shortDate(value) {
  if (!value) return '';
  const iso = String(value).slice(0, 10);
  const ms = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(ms)) return iso;
  const d = new Date(ms);
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

function tripTitle(trip, overBy) {
  const parts = [`${trip.name}: ${formatCents(trip.total_cents)}`];
  if (trip.budget_cents != null) {
    parts.push(
      overBy
        ? `budget ${formatCents(trip.budget_cents)}, over by ${formatCents(overBy)}`
        : `budget ${formatCents(trip.budget_cents)}`
    );
  }
  return parts.join(' · ');
}
