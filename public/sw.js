/**
 * ghrub service worker — installability plus a usable offline shell.
 *
 * Deliberately conservative: ghrub's whole value is live data (what is on the
 * list right now, what you just ticked). Serving a stale list from cache in the
 * middle of a shop would be worse than saying "you are offline", so:
 *
 *   - navigations and every mutation go to the network, always;
 *   - only the static shell (CSS, icons, manifest) is cached;
 *   - a failed navigation falls back to a plain offline page, never to a
 *     cached copy of someone's list.
 */

const CACHE = 'ghrub-shell-v1';
const SHELL = ['/static/css/app.css', '/static/icon.svg', '/static/manifest.webmanifest'];

const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline — ghrub</title>
<link rel="stylesheet" href="/static/css/app.css"></head>
<body><main class="wrap">
<header class="topbar"><h1>ghrub</h1></header>
<section class="card">
  <h2>You are offline</h2>
  <p class="muted">ghrub keeps your list on the server, so it needs a connection to
  show you the right thing. Nothing has been lost — reconnect and carry on.</p>
  <p><button class="btn" onclick="location.reload()">Try again</button></p>
</section>
</main></body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // mutations never touch the cache

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Static shell: cache first, it never changes within a release.
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then(cachePut(request)))
    );
    return;
  }

  // Everything else is live data. Network only, with an honest offline page.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(
        () =>
          new Response(OFFLINE_PAGE, {
            status: 503,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
      )
    );
  }
});

function cachePut(request) {
  return (response) => {
    if (response.ok) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  };
}
