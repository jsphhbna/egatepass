/**
 * scripts/build-production.mjs
 *
 * Production build executor for EARIST E-GatePass.
 *
 * 1. Strips unsupported npm_config_cache_dir environment variables to eliminate
 *    "npm warn Unknown env config 'cache-dir'" across all child operations.
 * 2. Runs prebuild asset synchronization (Tesseract assets, email templates, build meta).
 * 3. Executes TypeScript typecheck (tsc).
 * 4. Executes Vite production bundle build.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';

// Clean out unsupported env config that causes npm CLI warnings
delete process.env.npm_config_cache_dir;

const rootDir = process.cwd();
const execOpts = {
  cwd: rootDir,
  stdio: 'inherit',
  env: { ...process.env },
};

console.log('[BUILD-PROD] Starting production prebuild assets...');
execSync('node scripts/sync-tesseract-assets.mjs', execOpts);
execSync('node scripts/bundle-email-templates.mjs', execOpts);
execSync('node scripts/generate-build-meta.mjs', execOpts);

console.log('[BUILD-PROD] Running TypeScript typecheck...');
execSync('npx --no-install tsc', execOpts);

console.log('[BUILD-PROD] Running Vite production build...');
execSync('npx --no-install vite build', execOpts);

console.log('[BUILD-PROD] Production build completed successfully.');
