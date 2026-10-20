import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('target repository and Vercel routing contract', () => {
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
    expect(config.rewrites).toEqual([
      { source: '/(.*)', destination: '/index.html' },
    ]);
  });
});
