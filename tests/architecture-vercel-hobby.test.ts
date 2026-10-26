import { describe, expect, it } from 'vitest';
import { readdirSync, statSync, existsSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { ROUTE_CONTRACT_MATRIX, getRouteByPath, getRoutesByGroup, RouteContract } from '../server/route-map.js';
import { createGroupedRouter, extractRouteKey, resolveHandler } from '../server/router.js';

function getPhysicalApiFiles(dir: string): string[] {
  let results: string[] = [];
  if (!existsSync(dir)) return results;
  const list = readdirSync(dir);
  for (const item of list) {
    const full = join(dir, item);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results = results.concat(getPhysicalApiFiles(full));
    } else if (item.endsWith('.ts') || item.endsWith('.js')) {
      results.push(full);
    }
  }
  return results;
}

const EXPECTED_28_ROUTES = [
  // Admin (9)
  '/api/admin/activity',
  '/api/admin/dashboard',
  '/api/admin/devices',
  '/api/admin/emergency',
  '/api/admin/holds',
  '/api/admin/records',
  '/api/admin/retention-maintenance',
  '/api/admin/settings',
  '/api/admin/users',
  // Auth (4: 3 historical + 1 delivery observability webhook)
  '/api/auth/complete-password-change',
  '/api/auth/resend-webhook',
  '/api/auth/reset-password',
  '/api/auth/send-email-hook',
  // Passes (2)
  '/api/passes/email',
  '/api/passes/issue',
  // Device (4)
  '/api/create-device',
  '/api/delete-device',
  '/api/update-device',
  '/api/update-device-auth',
  // Gate (4)
  '/api/scan-pass',
  '/api/decide-visit',
  '/api/evidence',
  '/api/sync-offline-registration',
  // System (5)
  '/api/create-user',
  '/api/update-user',
  '/api/update-settings',
  '/api/purge-images',
  '/api/reconciliation-items',
] as const;

describe('Vercel Hobby Plan Function Limit Architecture Regressions', () => {
  describe('1. Physical Vercel Function Count Constraint (Hobby <= 8)', () => {
    it('contains no more than 8 physical function entrypoints under api/ (target: 6)', () => {
      const apiFiles = getPhysicalApiFiles('api');
      expect(apiFiles.length).toBeLessThanOrEqual(8);
      expect(apiFiles.length).toBe(6);
    });

    it('organizes all physical api/ entrypoints into clean grouped catch-all files', () => {
      const apiFiles = getPhysicalApiFiles('api').map((f) => f.replace(/\\/g, '/'));
      const expectedFiles = [
        'api/admin/[...route].ts',
        'api/auth/[...route].ts',
        'api/device/[...route].ts',
        'api/gate/[...route].ts',
        'api/passes/[...route].ts',
        'api/system/[...route].ts',
      ];
      expect(apiFiles.sort()).toEqual(expectedFiles.sort());
    });
  });

  describe('2. Route Contract Matrix Integrity (28 Preserved API Endpoints)', () => {
    it('contains exactly 28 route contracts in the matrix', () => {
      expect(ROUTE_CONTRACT_MATRIX.length).toBe(28);
    });

    it('contains all 28 historical external API paths with no duplicates', () => {
      const paths = ROUTE_CONTRACT_MATRIX.map((r) => r.path);
      const uniquePaths = new Set(paths);
      expect(uniquePaths.size).toBe(28);

      for (const expectedPath of EXPECTED_28_ROUTES) {
        expect(paths).toContain(expectedPath);
      }
    });

    it('every route in the matrix points to an existing handler module on disk', () => {
      for (const route of ROUTE_CONTRACT_MATRIX) {
        expect(existsSync(route.handlerModule), `Missing module: ${route.handlerModule} for ${route.path}`).toBe(true);
      }
    });

    it('every route defines at least one valid allowed HTTP method', () => {
      const validMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
      for (const route of ROUTE_CONTRACT_MATRIX) {
        expect(route.allowedMethods.length).toBeGreaterThan(0);
        for (const method of route.allowedMethods) {
          expect(validMethods).toContain(method);
        }
      }
    });

    it('allows lookup by path and by group', () => {
      expect(getRouteByPath('/api/admin/dashboard')?.subpath).toBe('dashboard');
      expect(getRouteByPath('/api/create-device')?.group).toBe('device');
      expect(getRoutesByGroup('auth').length).toBe(4);
      expect(getRoutesByGroup('passes').length).toBe(2);
      expect(getRoutesByGroup('device').length).toBe(4);
      expect(getRoutesByGroup('gate').length).toBe(4);
      expect(getRoutesByGroup('system').length).toBe(5);
      expect(getRoutesByGroup('admin').length).toBe(9);
    });
  });

  describe('3. Grouped Router Dispatch & Request Semantics Preservation', () => {
    it('extracts correct route keys from both direct and rewritten URL paths', () => {
      // Direct paths
      expect(extractRouteKey('/api/admin/dashboard', 'admin')).toBe('dashboard');
      expect(extractRouteKey('/api/admin/retention-maintenance', 'admin')).toBe('retention-maintenance');
      expect(extractRouteKey('/api/auth/reset-password', 'auth')).toBe('reset-password');
      expect(extractRouteKey('/api/passes/issue', 'passes')).toBe('issue');

      // Top-level rewritten paths
      expect(extractRouteKey('/api/create-device', 'device')).toBe('create-device');
      expect(extractRouteKey('/api/webhooks/resend', 'auth')).toBe('resend-webhook');
      expect(extractRouteKey('/api/device/create-device', 'device')).toBe('create-device');
      expect(extractRouteKey('/api/scan-pass', 'gate')).toBe('scan-pass');
      expect(extractRouteKey('/api/gate/scan-pass', 'gate')).toBe('scan-pass');
      expect(extractRouteKey('/api/sync-offline-registration', 'gate')).toBe('sync-offline-registration');
      expect(extractRouteKey('/api/gate/sync-offline-registration', 'gate')).toBe('sync-offline-registration');
      expect(extractRouteKey('/api/purge-images', 'system')).toBe('purge-images');
      expect(extractRouteKey('/api/system/purge-images', 'system')).toBe('purge-images');

      // Unknown or malformed
      expect(extractRouteKey('/api/admin', 'admin')).toBeNull();
      expect(extractRouteKey('/api', 'admin')).toBeNull();
      expect(extractRouteKey('/index.html', 'admin')).toBeNull();
    });

    it('dispatches to matching route handler and preserves request headers and query', async () => {
      let receivedReq: Request | null = null;
      const testRouter = createGroupedRouter('device', {
        'create-device': async (req: Request) => {
          receivedReq = req;
          return new Response(JSON.stringify({ ok: true, url: req.url }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      });

      const incomingUrl = 'http://localhost/api/create-device?param=test123';
      const req = new Request(incomingUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer test-token',
          'X-Client-Ip': '127.0.0.1',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ deviceName: 'Gate 1' }),
      });

      const res = await testRouter.fetch(req);
      expect(res.status).toBe(200);

      const json = await res.json();
      expect(json.ok).toBe(true);

      expect(receivedReq).not.toBeNull();
      expect(receivedReq!.headers.get('Authorization')).toBe('Bearer test-token');
      expect(receivedReq!.headers.get('X-Client-Ip')).toBe('127.0.0.1');
      expect(new URL(receivedReq!.url).searchParams.get('param')).toBe('test123');
    });

    it('returns a controlled 404 for unknown route without leaking internals', async () => {
      const testRouter = createGroupedRouter('admin', {
        dashboard: async () => new Response('dashboard'),
      });

      const req = new Request('http://localhost/api/admin/nonexistent-route', { method: 'GET' });
      const res = await testRouter.fetch(req);
      expect(res.status).toBe(404);
      const json = await res.json();
      expect(json).toEqual({ error: 'not_found' });
    });

    it('preserves handler 405 error responses and Allow headers', async () => {
      const testRouter = createGroupedRouter('admin', {
        activity: async (req: Request) => {
          if (req.method !== 'GET') {
            return new Response(JSON.stringify({ error: 'method_not_allowed' }), {
              status: 405,
              headers: { Allow: 'GET', 'Content-Type': 'application/json' },
            });
          }
          return new Response('ok');
        },
      });

      const req = new Request('http://localhost/api/admin/activity', { method: 'POST' });
      const res = await testRouter.fetch(req);
      expect(res.status).toBe(405);
      expect(res.headers.get('Allow')).toBe('GET');
      const json = await res.json();
      expect(json.error).toBe('method_not_allowed');
    });
  });

  describe('4. Vercel Configuration Rewrites for Legacy Top-Level Paths', () => {
    it('contains all 13 top-level API rewrites in vercel.json preceding the SPA fallback', () => {
      const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
        rewrites: Array<{ source: string; destination: string }>;
      };

      const topLevel13 = [
        { source: '/api/create-device', destination: '/api/device/create-device' },
        { source: '/api/delete-device', destination: '/api/device/delete-device' },
        { source: '/api/update-device', destination: '/api/device/update-device' },
        { source: '/api/update-device-auth', destination: '/api/device/update-device-auth' },
        { source: '/api/scan-pass', destination: '/api/gate/scan-pass' },
        { source: '/api/decide-visit', destination: '/api/gate/decide-visit' },
        { source: '/api/evidence', destination: '/api/gate/evidence' },
        { source: '/api/sync-offline-registration', destination: '/api/gate/sync-offline-registration' },
        { source: '/api/create-user', destination: '/api/system/create-user' },
        { source: '/api/update-user', destination: '/api/system/update-user' },
        { source: '/api/update-settings', destination: '/api/system/update-settings' },
        { source: '/api/purge-images', destination: '/api/system/purge-images' },
        { source: '/api/reconciliation-items', destination: '/api/system/reconciliation-items' },
      ];

      for (const expectedRewrite of topLevel13) {
        expect(config.rewrites).toContainEqual(expectedRewrite);
      }

      // Final rewrite must be SPA fallback
      const lastRewrite = config.rewrites[config.rewrites.length - 1];
      expect(lastRewrite).toEqual({ source: '/((?!api/).*)', destination: '/index.html' });
    });
  });
});
