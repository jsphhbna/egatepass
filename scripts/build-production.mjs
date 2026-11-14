/**
 * scripts/build-production.mjs
 *
 * Production build executor for EARIST E-GatePass.
 *
 * 1. Strips unsupported npm_config_cache_dir environment variables to eliminate
 *    "npm warn Unknown env config 'cache-dir'" across all child operations.
 * 2. Runs prebuild asset synchronization (Tesseract, PaddleOCR worker, and OpenCV runtime assets).
 * 3. Executes TypeScript typecheck directly via node.
 * 4. Executes Vite production bundle build directly via node.
 */

import { execSync } from 'node:child_process';
import path from 'node:path';

// Clean out unsupported env config that causes npm CLI warnings across all case variations
for (const key of Object.keys(process.env)) {
  if (key.toLowerCase().includes('cache_dir') || key.toLowerCase().includes('cache-dir')) {
    delete process.env[key];
  }
}

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
execSync('node node_modules/typescript/bin/tsc', execOpts);

console.log('[BUILD-PROD] Running Vite production build...');
execSync('node node_modules/vite/bin/vite.js build', execOpts);

// Ensure dist/build-meta.json has authoritative build metadata post-bundle
execSync('node scripts/generate-build-meta.mjs', execOpts);

console.log('[BUILD-PROD] Production build completed successfully.');
