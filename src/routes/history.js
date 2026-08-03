import { Router } from 'express';
import { formatCents } from '../lib/money.js';
import { spendHistory, cadence } from '../lib/insights.js';
import { spendPerTripChart, categorySpendChart } from '../lib/charts.js';

/**
 * GET /history — spend analytics (docs/06). A full page, no mutations, so
 * nothing here returns a partial.
 */
export function historyRouter(db) {
  const router = Router();

  router.get('/history', (_req, res) => {
    const history = spendHistory(db);
    res.render('history', {
      title: 'Spend history',
      history,
      cadence: cadence(db),
      spendChart: spendPerTripChart(history.trips),
      categoryChart: categorySpendChart(history.byCategory),
      formatCents,
    });
  });

  return router;
}
