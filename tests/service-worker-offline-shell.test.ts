import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

describe('Section I: Service Worker & Offline App Shell Reliability', () => {
  const swPath = path.resolve(process.cwd(), 'public/sw.js');
  let swSource: string;

  beforeEach(() => {
    swSource = fs.readFileSync(swPath, 'utf8');
  });

  function createSwSandbox(swUrl = 'https://egatepass.tech/sw.js?v=commit-bbb') {
    const listeners: Record<string, ((event: any) => void)[]> = {};
    const cacheStores = new Map<string, Map<string, Response>>();

    const mockCaches = {
      keys: vi.fn(async () => Array.from(cacheStores.keys())),
      open: vi.fn(async (cacheName: string) => {
        if (!cacheStores.has(cacheName)) {
          cacheStores.set(cacheName, new Map());
        }
        const store = cacheStores.get(cacheName)!;
        return {
          addAll: vi.fn(async (urls: string[]) => {
            for (const u of urls) store.set(u, new Response('<html>shell</html>', { status: 200 }));
          }),
          match: vi.fn(async (req: any) => {
            const key = typeof req === 'string' ? req : req.url;
            return store.get(key) || null;
          }),
          put: vi.fn(async (req: any, res: any) => {
            const key = typeof req === 'string' ? req : req.url;
            store.set(key, res);
          }),
        };
      }),
      delete: vi.fn(async (cacheName: string) => {
        return cacheStores.delete(cacheName);
      }),
      match: vi.fn(async (req: any) => {
        const key = typeof req === 'string' ? req : req.url;
        for (const store of cacheStores.values()) {
          if (store.has(key)) return store.get(key);
        }
        return null;
      }),
    };

    const mockFetch = vi.fn(async (req: any) => {
      const url = typeof req === 'string' ? req : req.url;
      if (url.includes('broken.js')) {
        throw new TypeError('Failed to fetch (404)');
      }
      return new Response(`response for ${url}`, { status: 200 });
    });

    const sandbox = {
      location: new URL(swUrl),
      self: {} as any,
      addEventListener: vi.fn((type: string, handler: (event: any) => void) => {
        listeners[type] = listeners[type] || [];
        listeners[type].push(handler);
      }),
      skipWaiting: vi.fn(async () => {}),
      clients: {
        claim: vi.fn(async () => {}),
      },
      caches: mockCaches,
      fetch: mockFetch,
      console,
      URL,
      Response,
      Promise,
      Array,
      Map,
      Set,
    };
    sandbox.self = sandbox;

    const context = vm.createContext(sandbox);
    vm.runInContext(swSource, context);

    return {
      sandbox,
      listeners,
      mockCaches,
      cacheStores,
      mockFetch,
    };
  }

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

  it('I.4: verifies that main.tsx posts asset discovery message to service worker on registration with build version', () => {
    const mainPath = path.resolve(process.cwd(), 'src/main.tsx');
    const mainContent = fs.readFileSync(mainPath, 'utf8');

    expect(mainContent).toContain("navigator.serviceWorker");
    expect(mainContent).toContain(".register(swUrl)");
    expect(mainContent).toContain("/sw.js?v=");
    expect(mainContent).toContain("type: 'PRECACHE_ASSETS'");
  });

  // =========================================================================
  // Section 9 VM-Backed Execution Tests Running Actual public/sw.js
  // =========================================================================

  it('I.5 (Behavioral): actual activate handler from sw.js purges obsolete egatepass caches but preserves current and external caches', async () => {
    const { listeners, mockCaches, cacheStores } = createSwSandbox('https://egatepass.tech/sw.js?v=commit-bbb');

    // Populate cacheStores with old and unrelated caches
    cacheStores.set('egatepass-shell-commit-aaa', new Map());
    cacheStores.set('egatepass-shell-commit-bbb', new Map()); // current
    cacheStores.set('egatepass-shell-v1', new Map());
    cacheStores.set('other-app-cache-v2', new Map());
    cacheStores.set('supabase-auth-token-cache', new Map());

    expect(listeners['activate']).toBeDefined();
    expect(listeners['activate'].length).toBeGreaterThan(0);

    let waitPromise: Promise<any> | null = null;
    const activateEvent = {
      waitUntil: vi.fn((p: Promise<any>) => {
        waitPromise = p;
      }),
    };

    listeners['activate'][0](activateEvent);
    expect(activateEvent.waitUntil).toHaveBeenCalled();
    await waitPromise;

    // Verify through the real evaluated code that old egatepass caches were deleted
    expect(mockCaches.delete).toHaveBeenCalledWith('egatepass-shell-commit-aaa');
    expect(mockCaches.delete).toHaveBeenCalledWith('egatepass-shell-v1');
    // Current cache and unrelated caches were NOT deleted
    expect(mockCaches.delete).not.toHaveBeenCalledWith('egatepass-shell-commit-bbb');
    expect(mockCaches.delete).not.toHaveBeenCalledWith('other-app-cache-v2');
    expect(mockCaches.delete).not.toHaveBeenCalledWith('supabase-auth-token-cache');
  });

  it('I.6 (Behavioral): PRECACHE_ASSETS actual message handler passes real pending Promise to waitUntil and populates cache', async () => {
    const { listeners, cacheStores } = createSwSandbox('https://egatepass.tech/sw.js?v=commit-bbb');

    expect(listeners['message']).toBeDefined();

    let waitPromise: Promise<any> | null = null;
    const messageEvent = {
      data: {
        type: 'PRECACHE_ASSETS',
        assets: ['/assets/main.js', '/assets/broken.js', '/assets/style.css'],
      },
      waitUntil: vi.fn((p: Promise<any>) => {
        waitPromise = p;
      }),
    };

    listeners['message'][0](messageEvent);
    expect(messageEvent.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    await waitPromise;

    const currentStore = cacheStores.get('egatepass-shell-commit-bbb');
    expect(currentStore).toBeDefined();
    expect(currentStore?.has('/assets/main.js')).toBe(true);
    expect(currentStore?.has('/assets/style.css')).toBe(true);
    // Broken asset was caught gracefully without failing the outer promise
    expect(currentStore?.has('/assets/broken.js')).toBe(false);
  });

  it('I.7 (Behavioral): actual fetch handler routes navigation requests and falls back to /index.html when offline', async () => {
    const { listeners, cacheStores, mockFetch } = createSwSandbox('https://egatepass.tech/sw.js?v=commit-bbb');

    // Pre-populate /index.html in cache
    const currentStore = new Map<string, Response>();
    currentStore.set('/index.html', new Response('<html>cached index</html>', { status: 200 }));
    cacheStores.set('egatepass-shell-commit-bbb', currentStore);

    expect(listeners['fetch']).toBeDefined();

    // 1. Simulate offline navigation: fetch throws
    mockFetch.mockImplementationOnce(async () => {
      throw new TypeError('Failed to fetch (offline)');
    });

    let navRespondPromise: Promise<Response> | null = null;
    const navEvent = {
      request: {
        url: 'https://egatepass.tech/admin/records',
        mode: 'navigate',
        method: 'GET',
      },
      respondWith: vi.fn((p: Promise<Response>) => {
        navRespondPromise = p;
      }),
    };

    listeners['fetch'][0](navEvent);
    expect(navEvent.respondWith).toHaveBeenCalled();
    const fallbackResponse = await navRespondPromise!;
    expect(fallbackResponse).not.toBeNull();
    const fallbackText = await fallbackResponse.text();
    expect(fallbackText).toBe('<html>cached index</html>');

    // 2. Simulate online navigation: fetch succeeds with 200
    mockFetch.mockImplementationOnce(async () => {
      return new Response('<html>fresh online index</html>', { status: 200 });
    });

    let onlineRespondPromise: Promise<Response> | null = null;
    const onlineNavEvent = {
      request: {
        url: 'https://egatepass.tech/guard',
        mode: 'navigate',
        method: 'GET',
      },
      respondWith: vi.fn((p: Promise<Response>) => {
        onlineRespondPromise = p;
      }),
    };

    listeners['fetch'][0](onlineNavEvent);
    expect(onlineNavEvent.respondWith).toHaveBeenCalled();
    const onlineResponse = await onlineRespondPromise!;
    expect(await onlineResponse.text()).toBe('<html>fresh online index</html>');
  });

  it('I.8 (Behavioral): actual fetch handler never intercepts API, REST, Storage, or non-GET requests', () => {
    const { listeners } = createSwSandbox('https://egatepass.tech/sw.js?v=commit-bbb');

    const testBypass = (url: string, method = 'GET') => {
      const event = {
        request: {
          url,
          mode: 'cors',
          method,
        },
        respondWith: vi.fn(),
      };
      listeners['fetch'][0](event);
      expect(event.respondWith).not.toHaveBeenCalled();
    };

    testBypass('https://egatepass.tech/api/admin/records');
    testBypass('https://egatepass.tech/api/create-user', 'POST');
    testBypass('https://egatepass.tech/rest/v1/gate_passes');
    testBypass('https://egatepass.tech/storage/v1/object/public/photos/vis-1.jpg');
    testBypass('https://egatepass.tech/assets/main.js', 'POST');
  });
});
