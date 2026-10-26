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
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_SHELL);
    }).then(() => self.skipWaiting())
  );
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
