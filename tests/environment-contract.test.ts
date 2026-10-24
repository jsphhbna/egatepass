import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REQUIRED_ACTIVE_RUNTIME_VARS = [
  'APP_BASE_URL',
  'VITE_SUPABASE_URL',
  'VITE_SUPABASE_PUBLISHABLE_KEY',
  'VITE_TURNSTILE_SITE_KEY',
  'SUPABASE_URL',
  'SUPABASE_SECRET_KEY',
  'PASS_TOKEN_SECRET',
  'RATE_LIMIT_HMAC_SECRET',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'SEND_EMAIL_HOOK_SECRET',
  'RESEND_WEBHOOK_SECRET',
  'CRON_SECRET',
];

const SERVER_ONLY_SECRET_NAMES = [
  'SUPABASE_SECRET_KEY',
  'PASS_TOKEN_SECRET',
  'RATE_LIMIT_HMAC_SECRET',
  'CRON_SECRET',
  'RESEND_API_KEY',
  'SEND_EMAIL_HOOK_SECRET',
  'RESEND_WEBHOOK_SECRET',
];

function getAllFiles(dir: string, extensions: string[]): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...getAllFiles(fullPath, extensions));
    } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
      files.push(fullPath);
    }
  }
  return files;
}

describe('Environment Contract & Safety Verification', () => {
  it('documents all required active runtime names in docs/ENVIRONMENT.md', () => {
    const doc = readFileSync('docs/ENVIRONMENT.md', 'utf8');
    for (const varName of REQUIRED_ACTIVE_RUNTIME_VARS) {
      expect(doc, `Missing ${varName} in docs/ENVIRONMENT.md`).toContain(`\`${varName}\``);
    }
  });

  it('declares all required active runtime names in .env.example', () => {
    const envExample = readFileSync('.env.example', 'utf8');
    const definedNames = envExample
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split('=')[0].trim());

    for (const varName of REQUIRED_ACTIVE_RUNTIME_VARS) {
      expect(definedNames, `Missing ${varName} in .env.example`).toContain(varName);
    }
  });

  it('contains zero committed secret values in .env.example', () => {
    const envExample = readFileSync('.env.example', 'utf8');
    const lines = envExample.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...rest] = trimmed.split('=');
      const val = rest.join('=').trim();
      expect(val, `Secret value detected in .env.example for key ${key}`).toBe('');
    }
  });

  it('prevents server secrets from using VITE_ prefix', () => {
    const envExample = readFileSync('.env.example', 'utf8');
    const lines = envExample.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const key = trimmed.split('=')[0].trim();
      if (key.startsWith('VITE_')) {
        expect(key).not.toMatch(/SECRET/i);
        expect(key).not.toMatch(/PRIVATE/i);
        expect(key).not.toMatch(/PASSWORD/i);
      }
    }
  });

  it('strictly prohibits frontend client source from referencing server secrets', () => {
    const clientFiles = getAllFiles('src', ['.ts', '.tsx', '.js', '.jsx']);

    for (const file of clientFiles) {
      const content = readFileSync(file, 'utf8');
      for (const secret of SERVER_ONLY_SECRET_NAMES) {
        expect(
          content.includes(secret),
          `Client file ${file} directly references server secret ${secret}`
        ).toBe(false);
      }
    }
  });

  it('prohibits Cloudflare Turnstile secret key from being placed under VITE_* or in client source', () => {
    const envExample = readFileSync('.env.example', 'utf8');
    const definedNames = envExample
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.split('=')[0].trim());

    // Private Turnstile secret belongs to hosted Supabase Auth Bot Protection, NEVER frontend
    for (const name of definedNames) {
      expect(name).not.toMatch(/VITE_.*TURNSTILE.*SECRET/i);
      expect(name).not.toMatch(/VITE_.*TURNSTILE.*KEY.*SECRET/i);
    }

    const clientFiles = getAllFiles('src', ['.ts', '.tsx', '.js', '.jsx']);
    for (const file of clientFiles) {
      const content = readFileSync(file, 'utf8');
      expect(content).not.toMatch(/TURNSTILE.*SECRET/i);
    }
  });
});
