import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDatabase } from './db/repo.js';
import { tripsRouter } from './routes/trips.js';
import { historyRouter } from './routes/history.js';
import { storesRouter } from './routes/stores.js';
import { kitchenRouter } from './routes/kitchen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the Express app. Exported so tests can mount it without binding a port.
 * DB access goes exclusively through the repository (docs/05 hard rule).
 * @param {object} [db] repository; defaults to a throwaway in-memory DB for tests.
 */
export function createApp(db = createDatabase(':memory:')) {
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Render health check — must not depend on the DB.
  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, app: 'ghrub' }));

  app.use('/', historyRouter(db));
  app.use('/', storesRouter(db));
  app.use('/', kitchenRouter(db));
  app.use('/', tripsRouter(db));

  return app;
}

// Start only when run directly (not when imported by a test).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  // Opens ./data/ghrub.db (or DATABASE_PATH) and migrates on boot if needed.
  const db = createDatabase();
  const app = createApp(db);
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`ghrub listening on http://localhost:${port}`);
  });
}
