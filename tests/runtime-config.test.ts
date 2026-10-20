import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { normalizeLoginIdentity } from '../src/lib/identity';
import { validateBrowserRuntimeConfig } from '../src/lib/runtimeConfig';

describe('browser runtime configuration', () => {
  it('accepts hosted HTTPS and local Supabase URLs', () => {
    expect(validateBrowserRuntimeConfig({
      VITE_SUPABASE_URL: 'https://project.supabase.co',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key',
    }).ok).toBe(true);
    expect(validateBrowserRuntimeConfig({
      VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key',
    }).ok).toBe(true);
  });

  it('fails closed for missing, malformed, or insecure remote configuration', () => {
    expect(validateBrowserRuntimeConfig({}).ok).toBe(false);
    expect(validateBrowserRuntimeConfig({
      VITE_SUPABASE_URL: 'not-a-url',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key',
    }).ok).toBe(false);
    expect(validateBrowserRuntimeConfig({
      VITE_SUPABASE_URL: 'http://example.test',
      VITE_SUPABASE_PUBLISHABLE_KEY: 'synthetic-public-key',
    }).ok).toBe(false);
  });
});

describe('shared login identity normalization', () => {
  it('preserves normalized staff email and maps only controlled device aliases', () => {
    expect(normalizeLoginIdentity(' Guard@EARIST.edu.ph ')).toEqual({ ok: true, email: 'guard@earist.edu.ph' });
    expect(normalizeLoginIdentity('gate-kiosk-01')).toEqual({ ok: true, email: 'gate-kiosk-01@devices.egatepass.invalid' });
    expect(normalizeLoginIdentity('../admin')).toEqual({ ok: false, message: 'Enter a valid staff email or device username.' });
  });
});

describe('bootstrap boundary', () => {
  it('mounts a shell before dynamically loading the application module', () => {
    const source = readFileSync('src/main.tsx', 'utf8');
    expect(source).not.toMatch(/import\s+\{\s*App\s*\}\s+from\s+['"]\.\/App['"]/);
    expect(source).toContain("import('./App')");
    expect(source).toContain('renderBootstrapFailure');
  });
});
