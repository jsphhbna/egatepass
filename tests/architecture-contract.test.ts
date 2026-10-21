import { readFileSync } from 'node:fs';
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

    for (const content of [clientEntry, clientApp, clientSupabase]) {
      expect(content).not.toContain('SUPABASE_SECRET_KEY');
      expect(content).not.toContain('PASS_TOKEN_SECRET');
      expect(content).not.toContain('RESEND_API_KEY');
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
});
