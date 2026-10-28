/* CourtReserve Watcher — service worker
 *
 * Strategy
 *   Same-origin files : network-first (always fresh when online), cache fallback when offline.
 *   Cross-origin      : not intercepted (the CDN state.json must never be served from cache).
 *
 * The previous version served the app shell cache-first from a cache named "crw-v1" that was
 * never bumped, so a browser that had loaded the page once kept the same index.html/app.js/
 * style.css forever. Network-first removes that failure mode: a deploy is picked up on the
 * next load. Bump VERSION only if the PRECACHE list itself changes.
 */
const VERSION = 2;
const CACHE = `crw-v${VERSION}`;
const OFFLINE_SHELL = 'index.html';
const PRECACHE = ['index.html', 'app.js', 'style.css', 'icon.png', 'manifest.json'];

// Live data: never intercepted, so app.js's `cache: 'no-store'` does its job.
const NEVER_CACHE = [/\/courtreserve-watcher\/state\.json$/i];

const NETWORK_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Individual puts rather than addAll(), so one missing file cannot abort the whole install.
    // Relative URLs resolve against the service worker's own location.
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        const res = await fetch(new URL(url, self.location.href).href, { cache: 'reload' });
        if (res && res.ok) await cache.put(url, res);
      } catch (_) {
        /* offline or 404: precache what we can */
      }
    }));
    await self.skipWaiting(); // don't wait for every old tab to close
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('crw-') && k !== CACHE).map((k) => caches.delete(k))
    );
    await self.clients.claim(); // take control of already-open pages
  })());
});

async function fetchWithTimeout(request) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function respond(request) {
  const cache = await caches.open(CACHE);

  try {
    const response = await fetchWithTimeout(request);
    if (response && response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (_) {
    // Network failed (offline, timeout, 5xx) — fall back to the last good copy.
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;

    if (request.mode === 'navigate') {
      const shell = await cache.match(OFFLINE_SHELL, { ignoreSearch: true });
      if (shell) return shell;
    }

    return new Response('Offline, and this file is not cached.', {
      status: 503,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_) {
    return;
  }

  // Let the browser handle the CDN data endpoint, Google Fonts, etc. directly.
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.some((re) => re.test(url.pathname))) return;

  event.respondWith(respond(request));
});
