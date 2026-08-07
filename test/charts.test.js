import { describe, it, expect } from 'vitest';
import { spendPerTripChart, categorySpendChart } from '../src/lib/charts.js';

const trip = (over) => ({
  id: 1,
  name: 'Trip',
  effective_date: '2026-01-01',
  line_count: 1,
  bought_count: 1,
  ...over,
});

describe('charts (src/lib/charts.js)', () => {
  it('keeps every mark inside the viewBox', async () => {
    const chart = spendPerTripChart([
      trip({ id: 1, total_cents: 30000, budget_cents: 50000 }),
      trip({ id: 2, total_cents: 90000, budget_cents: 50000, effective_date: '2026-02-01' }),
      trip({ id: 3, total_cents: 120000, budget_cents: null, effective_date: '2026-03-01' }),
    ]);

    for (const bar of chart.bars) {
      expect(bar.x).toBeGreaterThanOrEqual(chart.plot.x);
      expect(bar.x + bar.w).toBeLessThanOrEqual(chart.width);
      expect(bar.topY).toBeGreaterThanOrEqual(chart.plot.y - 0.01);
      expect(bar.topY - 6).toBeGreaterThan(0); // the direct label has room above
    }
    expect(chart.baseline).toBeLessThanOrEqual(chart.height);
  });

  it('splits an over-budget column at the budget, with the gap between segments', async () => {
    const chart = spendPerTripChart([trip({ total_cents: 90000, budget_cents: 50000 })]);
    const bar = chart.bars[0];

    expect(bar.isOver).toBe(true);
    expect(bar.segments.map((s) => s.kind)).toEqual(['within', 'over']);
    expect(bar.segments.every((s) => s.path !== '')).toBe(true);
    expect(bar.label).toBe('over');
    expect(bar.overBy).toBe(40000);
    expect(bar.budgetY).toBeNull(); // the split IS the budget; no extra tick
  });

  it('never draws a column shorter than the spend when the overshoot is a sliver', async () => {
    // 10c over a R500 budget: the overshoot scales to well under the 2px gap.
    const chart = spendPerTripChart([trip({ total_cents: 50010, budget_cents: 50000 })]);
    const bar = chart.bars[0];
    const full = spendPerTripChart([trip({ total_cents: 50010, budget_cents: null })]).bars[0];

    expect(bar.segments).toHaveLength(1);
    expect(bar.segments[0].kind).toBe('over');
    expect(bar.segments[0].path).not.toBe('');
    expect(bar.topY).toBeCloseTo(full.topY, 5); // same height as an unsplit column
    expect(bar.label).toBe('over');
  });

  it('marks the budget with a tick when a trip stayed under it', async () => {
    const chart = spendPerTripChart([trip({ total_cents: 30000, budget_cents: 50000 })]);
    const bar = chart.bars[0];

    expect(bar.isOver).toBe(false);
    expect(bar.label).toBeNull();
    expect(bar.budgetY).toBeLessThan(bar.topY); // budget sits above the column
    expect(bar.budgetTickX1).toBeLessThan(bar.x);
    expect(bar.budgetTickX2).toBeGreaterThan(bar.x + bar.w);
  });

  it('treats spending exactly the budget as within it', async () => {
    const bar = spendPerTripChart([trip({ total_cents: 50000, budget_cents: 50000 })]).bars[0];
    expect(bar.isOver).toBe(false);
    expect(bar.segments.map((s) => s.kind)).toEqual(['within']);
  });

  it('caps bar thickness so the band keeps its air', async () => {
    const chart = spendPerTripChart([trip({ total_cents: 1000, budget_cents: null })]);
    expect(chart.bars[0].w).toBeLessThanOrEqual(24);
  });

  it('puts axis ticks on clean money boundaries starting at zero', async () => {
    const chart = spendPerTripChart([trip({ total_cents: 93700, budget_cents: null })]);
    expect(chart.yTicks[0].label).toBe('R0.00');
    expect(chart.yTicks[0].y).toBe(chart.baseline);
    expect(chart.yTicks.at(-1).label).toMatch(/^R1 000\.00|R1 200\.00$/);
  });

  it('rounds the data-end and leaves the baseline square', async () => {
    const path = spendPerTripChart([trip({ total_cents: 50000, budget_cents: null })]).bars[0]
      .segments[0].path;
    expect(path).toContain('Q'); // rounded corners at the top
    expect(path.trim().endsWith('Z')).toBe(true);
  });

  it('grows the category chart with its rows and labels every tip', async () => {
    const rows = [
      {
        category_key: 'produce',
        category_label: 'Fruits and Veggies',
        avg_cents: 12000,
        trips_with_category: 9,
      },
      {
        category_key: 'pantry',
        category_label: 'Pantry Staples',
        avg_cents: 6000,
        trips_with_category: 7,
      },
      {
        category_key: 'frozen',
        category_label: 'Frozen goods',
        avg_cents: 0,
        trips_with_category: 0,
      },
    ];
    const chart = categorySpendChart(rows);

    expect(chart.rows).toHaveLength(2); // the zero-spend category is dropped
    expect(chart.height).toBeGreaterThan(chart.rows.length * 20);
    expect(chart.rows[0].w).toBeGreaterThan(chart.rows[1].w);
    expect(chart.rows[0].value).toBe('R120.00');
    expect(chart.rows.every((r) => r.valueX + 60 <= chart.width)).toBe(true);
  });

  it('reports empty rather than dividing by zero', async () => {
    expect(spendPerTripChart([]).empty).toBe(true);
    expect(spendPerTripChart([]).bars).toHaveLength(0);
    expect(categorySpendChart([]).empty).toBe(true);
    expect(spendPerTripChart([trip({ total_cents: 0, budget_cents: null })]).empty).toBe(true);
  });
});
