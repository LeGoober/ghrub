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

  // PWA (M5). Both are served from the root on purpose: a service worker can
  // only control the paths below its own URL, so one mounted at /static/sw.js
  // could never intercept the pages it exists for.
  const publicDir = path.join(__dirname, '..', 'public');
  app.get('/sw.js', (_req, res) => res.sendFile(path.join(publicDir, 'sw.js')));
  app.get('/manifest.webmanifest', (_req, res) =>
    res.sendFile(path.join(publicDir, 'manifest.webmanifest'))
  );

  app.use('/', historyRouter(db));
  app.use('/', storesRouter(db));
  app.use('/', kitchenRouter(db));
  app.use('/', tripsRouter(db));

  // Anything unmatched is a real 404 rather than Express's default HTML stub.
  app.use((_req, res) => {
    res.status(404).render('error-page', {
      title: 'Not found',
      status: 404,
      message: 'That page does not exist. It may have been a trip you have since deleted.',
    });
  });

  // Last line of defence: a rendering or DB failure shows a human page, never
  // a stack trace (docs/06 — "don't throw HTML 500s at the user").
  app.use((err, _req, res, _next) => {
    console.error('unhandled error:', err);
    res.status(500).render('error-page', {
      title: 'Something broke',
      status: 500,
      message: 'ghrub hit an unexpected error. Your list is safe — try that again.',
    });
  });

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
