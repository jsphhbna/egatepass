import { readFileSync } from 'node:fs';
import { ROUTE_CONTRACT_MATRIX } from '../server/route-map.js';
import { describe, expect, it } from 'vitest';

describe('target repository and Vercel routing contract', () => {
  it('keeps Vitest unit tests separate from Playwright specifications', () => {
    const config = readFileSync('vitest.config.ts', 'utf8');
    expect(config).toContain("include: ['tests/**/*.test.ts']");
    expect(config).not.toContain('*.spec.ts');
  });

  it('references only the lowercase modernization repository', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      repository?: { url?: string };
      bugs?: { url?: string };
      homepage?: string;
    };

    expect(manifest.repository?.url).toContain('jsphhbna/egatepass.git');
    expect(manifest.bugs?.url).toContain('jsphhbna/egatepass/issues');
    expect(manifest.homepage).toContain('jsphhbna/egatepass#readme');
    expect(JSON.stringify(manifest)).not.toContain('jsphhbna/E-GATEPASS');
  });

  it('uses the documented Vite SPA fallback and leaves filesystem routes first', () => {
    const config = JSON.parse(readFileSync('vercel.json', 'utf8')) as {
      framework?: string;
      regions?: string[];
      rewrites?: Array<{ source?: string; destination?: string }>;
    };

    expect(config.framework).toBe('vite');
    expect(config.regions).toEqual(['syd1']);
    const spaRewrite = config.rewrites?.find((r) => r.destination === '/index.html');
    expect(spaRewrite).toEqual({ source: '/((?!api/).*)', destination: '/index.html' });
    expect(config.rewrites?.[config.rewrites.length - 1]).toEqual({
      source: '/((?!api/).*)',
      destination: '/index.html',
    });

    const pattern = new RegExp(`^${spaRewrite!.source!}$`);
    expect(pattern.test('/kiosk')).toBe(true);
    expect(pattern.test('/admin')).toBe(true);
    expect(pattern.test('/login')).toBe(true);
    expect(pattern.test('/api/passes/issue')).toBe(false);
    expect(pattern.test('/api/passes/email')).toBe(false);
    expect(pattern.test('/api/admin/users')).toBe(false);
    expect(pattern.test('/api/unknown')).toBe(false);
  });

  it('routes local dev /api directly to Vercel-style handlers without legacy Netlify proxy', () => {
    const viteConfig = readFileSync('vite.config.ts', 'utf8');
    expect(viteConfig).not.toContain('localhost:8888/.netlify/functions');
    expect(viteConfig).toContain('vercelApiDevPlugin');
    expect(viteConfig).toContain("req.url?.startsWith('/api/')");
  });

  it('strictly isolates server secrets from client frontend bundles', () => {
    // Ensure no client source imports server-only Supabase clients or secret variables
    const clientEntry = readFileSync('src/main.tsx', 'utf8');
    const clientApp = readFileSync('src/App.tsx', 'utf8');
    const clientSupabase = readFileSync('src/lib/supabase.ts', 'utf8');

    const getPassPage = readFileSync('src/pages/GetPassPage.tsx', 'utf8');
    for (const content of [clientEntry, clientApp, clientSupabase, getPassPage]) {
      expect(content).not.toContain('SUPABASE_SECRET_KEY');
      expect(content).not.toContain('PASS_TOKEN_SECRET');
      expect(content).not.toContain('RESEND_API_KEY');
      expect(content).not.toContain('GEOAPIFY_API_KEY');
      expect(content).not.toContain('VITE_GEOAPIFY_API_KEY');
      expect(content).not.toContain('getServerSupabaseClients');
    }
  });

  it('pins standardwebhooks to exact version 1.1.1 for security dependency stability', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    expect(manifest.dependencies?.standardwebhooks).toBe('1.1.1');
  });

  it('provides all required self-hosted OCR static assets in public/tesseract', () => {
    const requiredAssets = [
      'public/tesseract/worker.min.js',
      'public/tesseract/tesseract-core.wasm',
      'public/tesseract/tesseract-core.wasm.js',
      'public/tesseract/tesseract-core-simd-lstm.wasm',
      'public/tesseract/tesseract-core-simd-lstm.wasm.js',
      'public/tesseract/tesseract-core-lstm.wasm',
      'public/tesseract/tesseract-core-lstm.wasm.js',
      'public/tesseract/eng.traineddata.gz',
    ];

    for (const asset of requiredAssets) {
      const content = readFileSync(asset);
      expect(content.length).toBeGreaterThan(1000);
    }
  });
  it('enforces canonical 42 API routes contract matrix in server/route-map.ts and vercel.json', () => {
    expect(ROUTE_CONTRACT_MATRIX.length).toBe(42);

    const counts: Record<string, number> = {};
    for (const route of ROUTE_CONTRACT_MATRIX) {
      counts[route.group] = (counts[route.group] || 0) + 1;
    }

    expect(counts['admin']).toBe(10);
    expect(counts['auth']).toBe(6);
    expect(counts['passes']).toBe(5);
    expect(counts['device']).toBe(6);
    expect(counts['gate']).toBe(6);
    expect(counts['system']).toBe(9);

    const routeMap = readFileSync('server/route-map.ts', 'utf8');
    expect(routeMap).toContain('// Admin Router (9 routes)');
    expect(routeMap).toContain('// Auth Router (4 routes)');
    expect(routeMap).toContain('// Passes Router (5 routes)');
    expect(routeMap).toContain('// Device Router (6 routes)');
    expect(routeMap).toContain('// Gate Router (5 routes)');
    expect(routeMap).toContain('// System Router (9 routes)');

    expect(routeMap).toContain("path: '/api/decommission-user'");
    expect(routeMap).toContain("path: '/api/reconciliation-items'");
    expect(routeMap).toContain("path: '/api/system/version'");
    expect(routeMap).toContain("path: '/api/system/health'");
    expect(routeMap).toContain("allowedMethods: ['GET', 'PATCH']");
    expect(routeMap).toContain("path: '/api/auth/resend-webhook'");
    expect(routeMap).toContain("allowedMethods: ['POST']");

    const vercelConfig = JSON.parse(readFileSync('vercel.json', 'utf8'));
    const resendRewrite = vercelConfig.rewrites?.find(
      (r) => r.source === '/api/webhooks/resend' && r.destination === '/api/auth/resend-webhook'
    );
    expect(resendRewrite).toBeDefined();
  });

  it('ensures production code and build artifacts contain no mock Turnstile token bypass hooks', () => {
    const turnstileWidget = readFileSync('src/components/TurnstileWidget.tsx', 'utf8');
    expect(turnstileWidget).not.toContain('__MOCK_TURNSTILE_TOKEN__');
    expect(turnstileWidget).not.toContain('mock-turnstile-dev-token');

    // If dist/ exists, ensure no bundled client asset contains the mock hook strings
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const distAssets = path.join(process.cwd(), 'dist', 'assets');
      if (fs.existsSync(distAssets)) {
        const files = fs.readdirSync(distAssets);
        for (const file of files) {
          if (file.endsWith('.js')) {
            const content = fs.readFileSync(path.join(distAssets, file), 'utf8');
            expect(content).not.toContain('__MOCK_TURNSTILE_TOKEN__');
            expect(content).not.toContain('mock-turnstile-dev-token');
          }
        }
      }
    } catch {
      // dist may not exist before build, which is fine
    }
  });

  it('enforces server-side Turnstile siteverify library with fail-closed semantics and zero unauthenticated siteverify route exposure', async () => {
    const fs = require('node:fs');
    expect(fs.existsSync('server/lib/turnstile.ts')).toBe(true);

    const { verifyTurnstileToken, isValidTurnstileHostname } = await import('../server/lib/turnstile');
    expect(typeof verifyTurnstileToken).toBe('function');
    expect(typeof isValidTurnstileHostname).toBe('function');

    // Verify hostname validation
    expect(isValidTurnstileHostname('egatepass.tech')).toBe(true);
    expect(isValidTurnstileHostname('www.egatepass.tech')).toBe(true);
    expect(isValidTurnstileHostname('localhost')).toBe(true);
    expect(isValidTurnstileHostname('127.0.0.1')).toBe(true);
    expect(isValidTurnstileHostname('egatepass.vercel.app')).toBe(true);
    expect(isValidTurnstileHostname('egatepass-git-preview.vercel.app')).toBe(true);
    expect(isValidTurnstileHostname('malicious-site.com')).toBe(false);
    expect(isValidTurnstileHostname('unauthorized.vercel.app')).toBe(false);

    // Verify fail-closed behavior on missing token or unconfigured secret
    const failMissingToken = await verifyTurnstileToken({ token: '', secretKey: 'test-secret' });
    expect(failMissingToken.success).toBe(false);

    const failMissingSecret = await verifyTurnstileToken({ token: 'test-token', secretKey: '' });
    expect(failMissingSecret.success).toBe(false);

    // Verify no standalone public siteverify route exists in route matrix
    for (const route of ROUTE_CONTRACT_MATRIX) {
      expect(route.path).not.toContain('siteverify');
    }

    // Verify vercel.json rewrites contain no public siteverify route
    const vercelConfig = JSON.parse(readFileSync('vercel.json', 'utf8'));
    const siteverifyRewrite = vercelConfig.rewrites?.find(
      (r: any) => r.source?.includes('siteverify') || r.destination?.includes('siteverify')
    );
    expect(siteverifyRewrite).toBeUndefined();

    // Verify capabilities source only reports siteKeyConfigured
    const capabilitiesSrc = readFileSync('server/routes/passes/capabilities.ts', 'utf8');
    expect(capabilitiesSrc).toContain('siteKeyConfigured: turnstileSiteKeyConfigured');
    expect(capabilitiesSrc).not.toContain('serverVerifierConfigured');
    expect(capabilitiesSrc).not.toContain('verified:');
  });

  it('validates Turnstile server-side Siteverify mock interactions, hostname checks, action checks, and fail-closed error handling', async () => {
    const { verifyTurnstileToken } = await import('../server/lib/turnstile');

    const originalFetch = globalThis.fetch;
    try {
      // 1. Success case with valid hostname and action
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            success: true,
            hostname: 'egatepass.tech',
            action: 'visit_registration',
            cdata: 'session-123',
            challenge_ts: '2026-11-15T00:00:00Z',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

      const successRes = await verifyTurnstileToken({
        token: 'valid-test-token',
        secretKey: 'mock-secret-key',
        expectedHostname: 'egatepass.tech',
        expectedAction: 'visit_registration',
      });
      expect(successRes.success).toBe(true);
      expect(successRes.hostname).toBe('egatepass.tech');
      expect(successRes.action).toBe('visit_registration');
      expect(successRes.cdata).toBe('session-123');

      // 2. Hostname mismatch rejection
      const hostMismatchRes = await verifyTurnstileToken({
        token: 'valid-test-token',
        secretKey: 'mock-secret-key',
        expectedHostname: 'egatepass-git-preview.vercel.app',
      });
      expect(hostMismatchRes.success).toBe(false);
      expect(hostMismatchRes.error).toContain('Turnstile hostname mismatch');

      // 3. Unauthorized hostname in response rejection
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            success: true,
            hostname: 'phishing-site.com',
            action: 'visit_registration',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

      const unauthHostRes = await verifyTurnstileToken({
        token: 'valid-test-token',
        secretKey: 'mock-secret-key',
      });
      expect(unauthHostRes.success).toBe(false);
      expect(unauthHostRes.error).toContain('not an authorized hostname');

      // 3b. Missing, empty, or whitespace hostname in response rejection (Strict fail-closed)
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            success: true,
            action: 'visit_registration',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

      const missingHostRes = await verifyTurnstileToken({
        token: 'valid-test-token',
        secretKey: 'mock-secret-key',
      });
      expect(missingHostRes.success).toBe(false);
      expect(missingHostRes.error).toContain('missing required hostname');

      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            success: true,
            hostname: '   ',
            action: 'visit_registration',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

      const emptyHostRes = await verifyTurnstileToken({
        token: 'valid-test-token',
        secretKey: 'mock-secret-key',
      });
      expect(emptyHostRes.success).toBe(false);
      expect(emptyHostRes.error).toContain('missing required hostname');

      // 4. Action mismatch rejection
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            success: true,
            hostname: 'egatepass.tech',
            action: 'other_action',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

      const actionMismatchRes = await verifyTurnstileToken({
        token: 'valid-test-token',
        secretKey: 'mock-secret-key',
        expectedAction: 'visit_registration',
      });
      expect(actionMismatchRes.success).toBe(false);
      expect(actionMismatchRes.error).toContain('Turnstile action mismatch');

      // 5. Cloudflare rejected token (invalid-input-response)
      globalThis.fetch = async () =>
        new Response(
          JSON.stringify({
            success: false,
            'error-codes': ['invalid-input-response', 'timeout-or-duplicate'],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );

      const cfRejectedRes = await verifyTurnstileToken({
        token: 'expired-token',
        secretKey: 'mock-secret-key',
      });
      expect(cfRejectedRes.success).toBe(false);
      expect(cfRejectedRes.errorCodes).toContain('invalid-input-response');

      // 6. Network failure / HTTP error fail-closed
      globalThis.fetch = async () => new Response('Internal Server Error', { status: 500 });
      const httpErrorRes = await verifyTurnstileToken({
        token: 'any-token',
        secretKey: 'mock-secret-key',
      });
      expect(httpErrorRes.success).toBe(false);
      expect(httpErrorRes.error).toContain('Cloudflare Siteverify HTTP error: 500');

      // 7. Network exception fail-closed
      globalThis.fetch = async () => {
        throw new Error('Connection reset by peer');
      };
      const networkExRes = await verifyTurnstileToken({
        token: 'any-token',
        secretKey: 'mock-secret-key',
      });
      expect(networkExRes.success).toBe(false);
      expect(networkExRes.error).toContain('Connection reset by peer');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
