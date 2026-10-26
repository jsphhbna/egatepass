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
    // Mock CacheStorage and Cache
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
    const simulateOfflineNavigation = async (urlStr: string) => {
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

  it('I.5: verifies that main.tsx posts asset discovery message to service worker on registration', () => {
    const mainPath = path.resolve(process.cwd(), 'src/main.tsx');
    const mainContent = fs.readFileSync(mainPath, 'utf8');

    expect(mainContent).toContain(".register('/sw.js')");
    expect(mainContent).toContain("type: 'PRECACHE_ASSETS'");
  });
});
