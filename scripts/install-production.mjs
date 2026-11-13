/**
 * scripts/install-production.mjs
 *
 * Clean installer for Vercel production build container.
 * Cleans any unsupported npm_config_cache_dir environment variables before
 * executing npm install.
 */

import { execSync } from 'node:child_process';

for (const key of Object.keys(process.env)) {
  if (key.toLowerCase().includes('cache_dir') || key.toLowerCase().includes('cache-dir')) {
    delete process.env[key];
  }
}

console.log('[INSTALL-PROD] Executing npm install with sanitized environment...');
execSync('npm install', { stdio: 'inherit', env: { ...process.env } });
