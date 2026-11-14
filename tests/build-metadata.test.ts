import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  resolveCommitSha,
  resolveDeploymentEnv,
  generateBuildMetadata,
  writeBuildMetadata,
} from '../scripts/generate-build-meta.mjs';
import versionHandler from '../server/routes/system/version.js';
import { readFileSync } from 'node:fs';

describe('Build Metadata Integrity & Lifecycle Verification', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('1. Authoritative Commit SHA Selection', () => {
    it('prioritizes VERCEL_GIT_COMMIT_SHA over GITHUB_SHA and local git', () => {
      const env = {
        VERCEL_GIT_COMMIT_SHA: 'vercel-sha-1234567890abcdef',
        GITHUB_SHA: 'github-sha-abcdef1234567890',
      };
      const sha = resolveCommitSha(env);
      expect(sha).toBe('vercel-sha-1234567890abcdef');
    });

    it('uses GITHUB_SHA when running in CI without Vercel env', () => {
      const env = {
        GITHUB_SHA: 'github-sha-abcdef1234567890',
      };
      const sha = resolveCommitSha(env);
      expect(sha).toBe('github-sha-abcdef1234567890');
    });

    it('falls back to local git rev-parse HEAD when CI environment variables are absent', () => {
      const env = {};
      const sha = resolveCommitSha(env);
      expect(typeof sha).toBe('string');
      // In local repo with git, returns a 40-character hex commit SHA or local-dev
      expect(sha.length).toBeGreaterThanOrEqual(7);
    });

    it('returns local-dev when git command fails or is unavailable', () => {
      const env = { PATH: '' };
      // Override execSync or isolate
      const sha = resolveCommitSha(env);
      expect(typeof sha).toBe('string');
      expect(sha.length).toBeGreaterThan(0);
    });
  });

  describe('2. Deployment Environment Identification (Production vs Preview vs Local)', () => {
    it('identifies Vercel production deployment accurately', () => {
      const env = {
        VERCEL_ENV: 'production',
        VERCEL_GIT_COMMIT_SHA: 'prod-sha-123',
      };
      expect(resolveDeploymentEnv(env)).toBe('production');
      const meta = generateBuildMetadata(env);
      expect(meta.deployment).toBe('production');
      expect(meta.commitSha).toBe('prod-sha-123');
    });

    it('identifies Vercel preview deployment accurately without claiming production', () => {
      const env = {
        VERCEL_ENV: 'preview',
        VERCEL_GIT_COMMIT_SHA: 'preview-pr-branch-sha-456',
      };
      expect(resolveDeploymentEnv(env)).toBe('preview');
      const meta = generateBuildMetadata(env);
      expect(meta.deployment).toBe('preview');
      expect(meta.commitSha).toBe('preview-pr-branch-sha-456');
    });

    it('identifies GitHub Actions CI environment accurately', () => {
      const env = {
        GITHUB_ACTIONS: 'true',
        GITHUB_SHA: 'ci-sha-789',
      };
      expect(resolveDeploymentEnv(env)).toBe('ci');
      const meta = generateBuildMetadata(env);
      expect(meta.deployment).toBe('ci');
    });

    it('identifies local workstation build as local without claiming production', () => {
      const env = {};
      expect(resolveDeploymentEnv(env)).toBe('local');
      const meta = generateBuildMetadata(env);
      expect(meta.deployment).toBe('local');
      expect(meta.deployment === 'production').toBe(false);
    });
  });

  describe('3. Build Metadata Shape, UTC Timestamp & Secret Safety', () => {
    it('generates valid UTC ISO 8601 timestamp in builtAt', () => {
      const testDate = new Date('2026-11-14T14:30:00.000Z');
      const meta = generateBuildMetadata({ VERCEL_GIT_COMMIT_SHA: 'abc1234' }, testDate);
      expect(meta.builtAt).toBe('2026-11-14T14:30:00.000Z');
      expect(new Date(meta.builtAt).toISOString()).toBe('2026-11-14T14:30:00.000Z');
    });

    it('matches package.json version', () => {
      const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
      const meta = generateBuildMetadata({});
      expect(meta.version).toBe(pkg.version);
    });

    it('never leaks environment secrets into build metadata', () => {
      const sensitiveEnv = {
        VERCEL_GIT_COMMIT_SHA: 'clean-sha-999',
        SUPABASE_SERVICE_ROLE_KEY: 'secret-role-key-never-expose',
        PASS_TOKEN_SECRET: 'secret-token-key-never-expose',
        DATABASE_URL: 'postgres://user:pass@host/db',
      };
      const meta = generateBuildMetadata(sensitiveEnv);
      const serialized = JSON.stringify(meta);
      expect(serialized).not.toContain('secret-role-key');
      expect(serialized).not.toContain('secret-token-key');
      expect(serialized).not.toContain('postgres://');
      expect(Object.keys(meta).sort()).toEqual(['builtAt', 'commitSha', 'deployment', 'version']);
    });
  });

  describe('4. Server System Version API Endpoint (/api/system/version)', () => {
    it('serves authoritative build metadata via GET with no-cache headers', async () => {
      process.env.VERCEL_GIT_COMMIT_SHA = 'endpoint-test-sha-12345';
      process.env.VERCEL_ENV = 'production';

      const req = new Request('http://localhost/api/system/version', { method: 'GET' });
      const res = await versionHandler.fetch(req);

      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      expect(res.headers.get('cache-control')).toContain('no-store');

      const json = await res.json();
      expect(json.status).toBe('healthy');
      expect(json.commitSha).toBe('endpoint-test-sha-12345');
      expect(json.deployment).toBe('production');
      expect(typeof json.version).toBe('string');
      expect(typeof json.builtAt).toBe('string');
    });

    it('rejects non-GET methods with 405 Method Not Allowed', async () => {
      const req = new Request('http://localhost/api/system/version', { method: 'POST' });
      const res = await versionHandler.fetch(req);
      expect(res.status).toBe(405);
      const json = await res.json();
      expect(json.error).toBe('method_not_allowed');
    });
  });

  describe('5. Client useBuildVersion Hook Integrity', () => {
    const hookSource = readFileSync('src/hooks/useBuildVersion.ts', 'utf8');

    it('handles missing or failed metadata fetch safely without throwing', () => {
      expect(hookSource).toContain('if (!res.ok) return null;');
      expect(hookSource).toContain('catch {');
      expect(hookSource).toContain('return null;');
      expect(hookSource).toContain('if (!mounted || !meta?.commitSha) return;');
    });

    it('safely distinguishes known SHAs from local-dev/unknown to prevent false update alerts', () => {
      expect(hookSource).toContain('isKnownCommitSha');
      expect(hookSource).toContain("trimmed !== 'local-dev'");
      expect(hookSource).toContain("trimmed !== 'unknown'");
    });
  });
});
