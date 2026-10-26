/**
 * E-GatePass Minimal Static App-Shell Service Worker (Phase 5.1)
 *
 * Invariants:
 * - Caches ONLY static application assets (HTML, CSS, JS, logos).
 * - NEVER caches authenticated API responses (/api/*, /rest/*).
 * - NEVER caches visitor evidence or sensitive storage objects (/storage/*).
 * - Sensitive operational data is managed strictly in IndexedDB.
 */

const CACHE_NAME = 'egatepass-shell-v1';
const STATIC_SHELL = [
  '/',
  '/index.html',
  '/earist-logo.png',
  '/earist-main-building.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      await cache.addAll(STATIC_SHELL);
      try {
        const res = await fetch('/index.html');
        if (res.ok) {
          const html = await res.text();
          // Extract /assets/*.js and /assets/*.css script/link tags
          const assetMatches = Array.from(html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)).map((m) => m[1]);
          if (assetMatches.length > 0) {
            await Promise.all(
              assetMatches.map((assetUrl) =>
                fetch(assetUrl)
                  .then((assetRes) => {
                    if (assetRes.ok) return cache.put(assetUrl, assetRes);
                  })
                  .catch(() => undefined)
              )
            );
          }
        }
      } catch (err) {
        console.warn('App-shell asset discovery during install:', err);
      }
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'PRECACHE_ASSETS' && Array.isArray(event.data.assets)) {
    event.waitUntil(
      caches.open(CACHE_NAME).then(async (cache) => {
        for (const assetUrl of event.data.assets) {
          if (typeof assetUrl === 'string' && (assetUrl.startsWith('/assets/') || assetUrl.startsWith('/'))) {
            const match = await cache.match(assetUrl);
            if (!match) {
              fetch(assetUrl)
                .then((res) => {
                  if (res.ok) cache.put(assetUrl, res);
                })
                .catch(() => undefined);
            }
          }
        }
      })
    );
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Security: NEVER cache API calls, Supabase REST, or storage evidence
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/rest/v1/') ||
    url.pathname.startsWith('/storage/v1/') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // Navigation requests: Network-first, fallback to /index.html for SPA offline loading
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => {
        return caches.match('/index.html').then((response) => {
          return response || fetch(event.request);
        });
      })
    );
    return;
  }

  // Static assets (JS/CSS/images): Stale-while-revalidate
  if (
    url.pathname.startsWith('/assets/') ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.css') ||
    url.pathname.endsWith('.png') ||
    url.pathname.endsWith('.webp') ||
    url.pathname.endsWith('.wasm')
  ) {
    event.respondWith(
      caches.match(event.request).then((cached) => {
        const fetchPromise = fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return networkResponse;
        }).catch(() => cached);

        return cached || fetchPromise;
      })
    );
  }
});
