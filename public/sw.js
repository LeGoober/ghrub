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
 *     cached copy of someone's list;
 *   - a navigation the server is slow to answer (Render's free plan sleeps
 *     after 15 idle minutes and takes ~30-50s to wake) shows a "waking up"
 *     screen after a few seconds instead of a blank white one. That screen
 *     polls /healthz and reloads the moment the server answers.
 */

// Bump on any release that changes the shell. A changed sw.js is what makes
// the browser install a new worker at all, and activate() then drops the old
// cache — v1 was never bumped after the mobile rebuild, so installed copies
// kept serving the pre-mobile stylesheet.
const CACHE = 'ghrub-shell-v3';
const SHELL = [
  '/static/css/app.css',
  '/static/icon.svg',
  '/static/icon-192.png',
  '/static/vendor/htmx/htmx.min.js',
];

/** How long a navigation may take before the waking screen is shown. */
const WAKE_AFTER_MS = 4000;

const WAKING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f6f4a">
<title>Waking ghrub up…</title>
<link rel="stylesheet" href="/static/css/app.css">
<style>
  .waking{min-height:100dvh;display:grid;place-items:center;text-align:center;padding:24px}
  .waking img{width:84px;height:84px;border-radius:22px;box-shadow:var(--shadow-3)}
  .waking h1{font-size:1.5rem;margin:20px 0 6px}
  .waking .dots{display:flex;gap:6px;justify-content:center;margin-top:20px}
  .waking .dots span{width:8px;height:8px;border-radius:50%;background:var(--accent);animation:pulse 1.2s infinite ease-in-out}
  .waking .dots span:nth-child(2){animation-delay:.15s}.waking .dots span:nth-child(3){animation-delay:.3s}
  @keyframes pulse{0%,80%,100%{opacity:.25;transform:scale(.8)}40%{opacity:1;transform:none}}
</style></head>
<body><main class="waking"><div>
  <img src="/static/icon-192.png" alt="">
  <h1>Waking ghrub up…</h1>
  <p class="muted">The server naps when nobody is shopping.<br>This takes up to a minute — your list is safe.</p>
  <div class="dots" aria-hidden="true"><span></span><span></span><span></span></div>
</div></main>
<script>
  (async function poll() {
    try {
      const r = await fetch('/healthz', { cache: 'no-store' });
      if (r.ok) return location.reload();
    } catch (e) {}
    setTimeout(poll, 2000);
  })();
</script></body></html>`;

const OFFLINE_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Offline — ghrub</title>
<link rel="stylesheet" href="/static/css/app.css"></head>
<body><main class="wrap">
<header class="app-bar app-bar-large"><div class="app-bar-title"><h1>ghrub</h1></div></header>
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

  // The receipt reader's engine (~6MB of WASM and model) is version-pinned and
  // never changes in place: cache first, so the second scan downloads nothing.
  if (url.pathname.startsWith('/static/vendor/')) {
    event.respondWith(
      caches.match(request).then((hit) => hit || fetch(request).then(cachePut(request)))
    );
    return;
  }

  // The rest of the shell: serve the cached copy instantly, and refresh it in
  // the background, so a release reaches installed phones on the next visit
  // even if nobody remembers to bump CACHE.
  if (url.pathname.startsWith('/static/')) {
    event.respondWith(
      caches.match(request).then((hit) => {
        const fresh = fetch(request)
          .then(cachePut(request))
          .catch(() => hit);
        return hit || fresh;
      })
    );
    return;
  }

  // Everything else is live data. Network only, with an honest offline page —
  // and a waking screen when the server is cold. The real request keeps going
  // in the background either way, which is what wakes the server up.
  if (request.mode === 'navigate') {
    const html = (body, status) =>
      new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
    const network = fetch(request).catch(() => html(OFFLINE_PAGE, 503));
    const waking = new Promise((resolve) =>
      setTimeout(() => resolve(html(WAKING_PAGE, 503)), WAKE_AFTER_MS)
    );
    event.respondWith(Promise.race([network, waking]));
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
