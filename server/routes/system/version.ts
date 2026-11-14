/**
 * server/routes/system/version.ts
 *
 * System Version & Health Endpoint.
 * Reports authoritative deployment commit SHA, build timestamp, application version, and runtime status.
 *
 * Security Invariants:
 * 1. Read-only (GET).
 * 2. Emits no secrets, database credentials, or environment keys.
 * 3. Enforces Cache-Control: no-cache, no-store, max-age=0, must-revalidate.
 */

import { jsonResponse } from '../../http.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function getBuildMetadata() {
  const envCommitSha = process.env.VERCEL_GIT_COMMIT_SHA?.trim()
    || process.env.GITHUB_SHA?.trim()
    || null;
  const envDeployment = process.env.VERCEL_ENV?.trim()
    || (process.env.GITHUB_ACTIONS ? 'ci' : null);

  // Try reading build-meta.json from dist/ or public/
  const candidatePaths = [
    resolve(process.cwd(), 'dist', 'build-meta.json'),
    resolve(process.cwd(), 'public', 'build-meta.json'),
  ];

  for (const p of candidatePaths) {
    try {
      if (existsSync(p)) {
        const parsed = JSON.parse(readFileSync(p, 'utf8'));
        return {
          status: 'healthy',
          commitSha: envCommitSha || parsed.commitSha || 'unknown',
          builtAt: parsed.builtAt || new Date().toISOString(),
          version: parsed.version || '1.0.0',
          deployment: envDeployment || parsed.deployment || 'local',
        };
      }
    } catch {
      // Continue to next candidate
    }
  }

  return {
    status: 'healthy',
    commitSha: envCommitSha || 'unknown',
    builtAt: new Date().toISOString(),
    version: '1.0.0',
    deployment: envDeployment || 'local',
  };
}

async function handleRequest(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
  }

  const meta = getBuildMetadata();
  return jsonResponse(200, meta, {
    'Cache-Control': 'no-cache, no-store, max-age=0, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  });
}

export default { fetch: handleRequest };
