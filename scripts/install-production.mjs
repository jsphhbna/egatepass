/**
 * scripts/install-production.mjs
 *
 * Clean installer for Vercel production build container.
 * Cleans any unsupported npm_config_cache_dir environment variables before
 * executing npm install.
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

for (const key of Object.keys(process.env)) {
  if (key.toLowerCase().includes('cache_dir') || key.toLowerCase().includes('cache-dir')) {
    delete process.env[key];
  }
}

console.log('[INSTALL-PROD] Executing npm install with sanitized environment...');
execSync('npm install', { stdio: 'inherit', env: { ...process.env } });

// On Linux / Vercel build containers, prune unused platform native binaries from onnxruntime-node
// to prevent @vercel/nft from packing multi-OS binaries into serverless function packages
if (process.platform === 'linux' || process.env.VERCEL === '1') {
  try {
    const onnxNapiDir = path.resolve(process.cwd(), 'node_modules/onnxruntime-node/bin/napi-v6');
    if (fs.existsSync(onnxNapiDir)) {
      const unusedPlatforms = ['darwin', 'win32', 'linux/arm64'];
      for (const target of unusedPlatforms) {
        const targetPath = path.resolve(onnxNapiDir, target);
        if (fs.existsSync(targetPath)) {
          console.log(`[INSTALL-PROD] Pruning non-production onnxruntime binary directory: ${target}`);
          fs.rmSync(targetPath, { recursive: true, force: true });
        }
      }
    }
  } catch (err) {
    console.warn('[INSTALL-PROD] Notice: Could not prune onnxruntime-node native binaries:', err);
  }
}
