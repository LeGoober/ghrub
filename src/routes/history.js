import { Router } from 'express';
import { formatCents } from '../lib/money.js';
import { spendHistory, cadence } from '../lib/insights.js';
import { spendPerTripChart, categorySpendChart } from '../lib/charts.js';
import { wrap } from './wrap.js';

/**
 * GET /history — spend analytics (docs/06). A full page, no mutations, so
 * nothing here returns a partial.
 */
export function historyRouter(db) {
  const router = Router();

  router.get(
    '/history',
    wrap(async (_req, res) => {
      const [history, cadenceInfo] = await Promise.all([spendHistory(db), cadence(db)]);
      res.render('history', {
        title: 'Spend history',
        history,
        cadence: cadenceInfo,
        spendChart: spendPerTripChart(history.trips),
        categoryChart: categorySpendChart(history.byCategory),
        formatCents,
      });
    })
  );

  return router;
}
