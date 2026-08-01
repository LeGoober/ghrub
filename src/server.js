import express from 'express';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Build the Express app. Exported so tests can mount it without binding a port.
 * M0: health check + placeholder home. M1+ mounts routers (see docs/06).
 */
export function createApp() {
  const app = express();

  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use('/static', express.static(path.join(__dirname, '..', 'public')));
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  // Render health check — must not depend on the DB.
  app.get('/healthz', (_req, res) => res.status(200).json({ ok: true, app: 'ghrub' }));

  app.get('/', (_req, res) => {
    res.render('home', { title: 'ghrub' });
  });

  return app;
}

// Start only when run directly (not when imported by a test).
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  const app = createApp();
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`ghrub listening on http://localhost:${port}`);
  });
}
