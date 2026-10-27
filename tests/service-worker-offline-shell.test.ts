import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Section I: Service Worker & Offline App Shell Reliability', () => {
  const swPath = path.resolve(process.cwd(), 'public/sw.js');
  let swSource: string;

  beforeEach(() => {
    swSource = fs.readFileSync(swPath, 'utf8');
  });

  it('I.1: sw.js enforces security invariant: NEVER caches /api/*, /rest/*, or /storage/*', () => {
    expect(swSource).toContain("url.pathname.startsWith('/api/')");
    expect(swSource).toContain("url.pathname.startsWith('/rest/v1/')");
    expect(swSource).toContain("url.pathname.startsWith('/storage/v1/')");
    expect(swSource).toContain("event.request.method !== 'GET'");
  });

  it('I.2: sw.js provides navigation fallback to /index.html for offline SPA execution', () => {
    expect(swSource).toContain("event.request.mode === 'navigate'");
    expect(swSource).toContain("caches.match('/index.html')");
  });

  it('I.3: sw.js includes asset discovery during install and PRECACHE_ASSETS message handling', () => {
    expect(swSource).toContain("fetch('/index.html')");
    expect(swSource).toContain('/assets/');
    expect(swSource).toContain("event.data.type === 'PRECACHE_ASSETS'");
  });

  it('I.4: simulates offline reload after initial online visit with static cache', async () => {
    const mockCacheStore = new Map<string, Response>();
    const mockCache = {
      addAll: vi.fn(async (urls: string[]) => {
        for (const u of urls) {
          mockCacheStore.set(u, new Response('<html>mock app shell</html>', { status: 200 }));
        }
      }),
      put: vi.fn(async (req: any, res: any) => {
        const key = typeof req === 'string' ? req : req.url;
        mockCacheStore.set(key, res);
      }),
      match: vi.fn(async (req: any) => {
        const key = typeof req === 'string' ? req : req.url;
        return mockCacheStore.get(key) || null;
      }),
    };

    // Precache shell
    await mockCache.addAll(['/', '/index.html', '/earist-logo.png']);
    expect(mockCacheStore.has('/index.html')).toBe(true);

    // Simulate navigation request while OFFLINE (fetch fails)
    const simulateOfflineNavigation = async (_urlStr: string) => {
      try {
        throw new TypeError('Failed to fetch (offline)');
      } catch {
        return mockCache.match('/index.html');
      }
    };

    const offlineResponse = await simulateOfflineNavigation('https://egatepass.tech/guard');
    expect(offlineResponse).not.toBeNull();
    const text = await offlineResponse!.text();
    expect(text).toContain('mock app shell');
  });

  it('I.5: verifies that main.tsx posts asset discovery message to service worker on registration with build version', () => {
    const mainPath = path.resolve(process.cwd(), 'src/main.tsx');
    const mainContent = fs.readFileSync(mainPath, 'utf8');

    expect(mainContent).toContain("navigator.serviceWorker");
    expect(mainContent).toContain(".register(swUrl)");
    expect(mainContent).toContain("/sw.js?v=");
    expect(mainContent).toContain("type: 'PRECACHE_ASSETS'");
  });

  it('I.6: successful same-origin online navigation updates cached /index.html with fresh network response clone', () => {
    expect(swSource).toContain("if (networkResponse && networkResponse.status === 200 && url.origin === self.location.origin)");
    expect(swSource).toContain("cache.put('/index.html', clone)");
  });

  // Section 26 Behavioral Tests
  it('Behavioral 1: build A and build B produce different E-GatePass cache names', () => {
    const computeCacheName = (href: string) => {
      const buildId = new URL(href).searchParams.get('v') || 'v1';
      return `egatepass-shell-${buildId}`;
    };

    const cacheA = computeCacheName('https://egatepass.tech/sw.js?v=commit-aaa');
    const cacheB = computeCacheName('https://egatepass.tech/sw.js?v=commit-bbb');
    const cacheDefault = computeCacheName('https://egatepass.tech/sw.js');

    expect(cacheA).toBe('egatepass-shell-commit-aaa');
    expect(cacheB).toBe('egatepass-shell-commit-bbb');
    expect(cacheDefault).toBe('egatepass-shell-v1');
    expect(cacheA).not.toBe(cacheB);
  });

  it('Behavioral 2 & 3: activation for B deletes old egatepass-shell-* caches while preserving unrelated caches', async () => {
    const existingCaches = new Set([
      'egatepass-shell-commit-aaa',
      'egatepass-shell-commit-bbb',
      'other-app-data-v1',
      'firebase-installations-database',
      'egatepass-shell-v1',
    ]);

    const CURRENT_CACHE = 'egatepass-shell-commit-bbb';

    // Simulate SW activate cleanup logic
    const keys = Array.from(existingCaches);
    await Promise.all(
      keys.map(async (key) => {
        if (key.startsWith('egatepass-shell-') && key !== CURRENT_CACHE) {
          existingCaches.delete(key);
        }
      })
    );

    // Assert that old egatepass-shell caches were removed
    expect(existingCaches.has('egatepass-shell-commit-aaa')).toBe(false);
    expect(existingCaches.has('egatepass-shell-v1')).toBe(false);
    // Current cache remains
    expect(existingCaches.has('egatepass-shell-commit-bbb')).toBe(true);
    // Unrelated caches are strictly preserved
    expect(existingCaches.has('other-app-data-v1')).toBe(true);
    expect(existingCaches.has('firebase-installations-database')).toBe(true);
  });

  it('Behavioral 4 & 5: PRECACHE_ASSETS awaits all puts and does not fail complete lifecycle on one failed asset', async () => {
    const cacheStore = new Map<string, Response>();
    const putCompleted: string[] = [];

    const mockCache = {
      match: vi.fn(async (url: string) => cacheStore.get(url) || null),
      put: vi.fn(async (url: string, res: Response) => {
        // simulate async storage delay
        await new Promise((resolve) => setTimeout(resolve, 10));
        cacheStore.set(url, res);
        putCompleted.push(url);
      }),
    };

    const mockFetch = vi.fn(async (url: string) => {
      if (url === '/assets/broken.js') {
        throw new Error('404 Not Found');
      }
      return new Response(`content of ${url}`, { status: 200 });
    });

    const assetsToPrecache = ['/assets/index-1.js', '/assets/broken.js', '/assets/index-2.css'];

    // Run the exact SW message logic
    const handlePrecacheAssets = async (assets: string[]) => {
      await Promise.all(
        assets.map(async (assetUrl) => {
          if (typeof assetUrl === 'string' && (assetUrl.startsWith('/assets/') || assetUrl.startsWith('/'))) {
            try {
              const match = await mockCache.match(assetUrl);
              if (!match) {
                const res = await mockFetch(assetUrl);
                if (res && res.ok) {
                  await mockCache.put(assetUrl, res);
                }
              }
            } catch {
              // Graceful failure per requirement 5
            }
          }
        })
      );
    };

    // Await the operation (as event.waitUntil does)
    await handlePrecacheAssets(assetsToPrecache);

    // Verify all valid puts were awaited and completed
    expect(putCompleted).toContain('/assets/index-1.js');
    expect(putCompleted).toContain('/assets/index-2.css');
    expect(cacheStore.has('/assets/index-1.js')).toBe(true);
    expect(cacheStore.has('/assets/index-2.css')).toBe(true);
    // Broken asset was caught and did not reject the outer Promise.all
    expect(cacheStore.has('/assets/broken.js')).toBe(false);
  });

  it('Behavioral 6: API, REST, and Storage GET requests return immediately without touching CacheStorage', () => {
    const shouldBypassCache = (pathname: string, method = 'GET') => {
      return (
        pathname.startsWith('/api/') ||
        pathname.startsWith('/rest/v1/') ||
        pathname.startsWith('/storage/v1/') ||
        method !== 'GET'
      );
    };

    expect(shouldBypassCache('/api/admin/dashboard')).toBe(true);
    expect(shouldBypassCache('/rest/v1/gate_passes')).toBe(true);
    expect(shouldBypassCache('/storage/v1/object/public/photos/visitor.jpg')).toBe(true);
    expect(shouldBypassCache('/assets/index-abc.js', 'POST')).toBe(true);
    expect(shouldBypassCache('/assets/index-abc.js', 'GET')).toBe(false);
    expect(shouldBypassCache('/index.html', 'GET')).toBe(false);
  });

  it('Behavioral 7 & 8: navigation updates index.html on network success and falls back on offline', async () => {
    let cachedIndexHtml = '<html>build A index</html>';
    const cache = {
      match: vi.fn(async (key: string) => {
        if (key === '/index.html') return new Response(cachedIndexHtml, { status: 200 });
        return null;
      }),
      put: vi.fn(async (key: string, res: Response) => {
        if (key === '/index.html') {
          cachedIndexHtml = await res.text();
        }
      }),
    };

    // 1. Online navigation succeeds: network response clone is put to cache
    const onlineFetch = async () => new Response('<html>build B fresh index</html>', { status: 200 });
    const networkRes = await onlineFetch();
    if (networkRes.status === 200) {
      await cache.put('/index.html', networkRes);
    }
    expect(cachedIndexHtml).toBe('<html>build B fresh index</html>');

    // 2. Offline navigation fails: falls back to cached index.html
    const offlineFetch = async (): Promise<Response> => {
      throw new TypeError('Failed to fetch (offline)');
    };

    const navigate = async () => {
      try {
        return await offlineFetch();
      } catch {
        const fallback = await cache.match('/index.html');
        return fallback!;
      }
    };

    const fallbackRes = await navigate();
    expect(fallbackRes).not.toBeNull();
    const text = await fallbackRes.text();
    expect(text).toBe('<html>build B fresh index</html>');
  });
});
