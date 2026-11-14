/**
 * scripts/generate-build-meta.mjs
 *
 * Authoritative production build metadata generator for EARIST E-GatePass.
 *
 * Security & Integrity Invariants:
 * 1. Prioritizes VERCEL_GIT_COMMIT_SHA (Vercel deployment commit).
 * 2. Falls back to GITHUB_SHA (GitHub Actions CI).
 * 3. Falls back to local git rev-parse HEAD (local workstation).
 * 4. Safe non-throwing fallback ('local-dev') when git is unavailable.
 * 5. Identifies deployment environment (production, preview, ci, local) truthfully.
 * 6. Never exposes environment variables, secrets, or system tokens.
 * 7. Emits UTC ISO 8601 builtAt timestamp.
 * 8. Writes to both public/ and dist/ (if present) to prevent stale cache reuse.
 */

import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function resolveCommitSha(env = process.env) {
  if (env.VERCEL_GIT_COMMIT_SHA && typeof env.VERCEL_GIT_COMMIT_SHA === 'string') {
    const trimmed = env.VERCEL_GIT_COMMIT_SHA.trim();
    if (trimmed) return trimmed;
  }
  if (env.GITHUB_SHA && typeof env.GITHUB_SHA === 'string') {
    const trimmed = env.GITHUB_SHA.trim();
    if (trimmed) return trimmed;
  }
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'local-dev';
  }
}

export function resolveDeploymentEnv(env = process.env) {
  if (env.VERCEL_ENV && typeof env.VERCEL_ENV === 'string') {
    const trimmed = env.VERCEL_ENV.trim().toLowerCase();
    if (trimmed) return trimmed;
  }
  if (env.GITHUB_ACTIONS) {
    return 'ci';
  }
  return 'local';
}

export function generateBuildMetadata(env = process.env, timestamp = new Date()) {
  const commitSha = resolveCommitSha(env);
  const deployment = resolveDeploymentEnv(env);

  let version = '1.0.0';
  try {
    const pkgPath = resolve(process.cwd(), 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      if (pkg.version) version = String(pkg.version).trim();
    }
  } catch {
    // Keep default 1.0.0
  }

  return {
    commitSha,
    builtAt: timestamp.toISOString(),
    version,
    deployment,
  };
}

export function writeBuildMetadata(
  targetPaths = ['public/build-meta.json', 'dist/build-meta.json'],
  env = process.env
) {
  const meta = generateBuildMetadata(env);
  const jsonContent = JSON.stringify(meta, null, 2) + '\n';

  for (const relPath of targetPaths) {
    try {
      const absPath = resolve(process.cwd(), relPath);
      // For dist/, only write if dist directory exists (or parent is created)
      mkdirSync(dirname(absPath), { recursive: true });
      writeFileSync(absPath, jsonContent, 'utf8');
      console.log(`[BUILD-META] Generated ${absPath} (${meta.commitSha.slice(0, 8)} [${meta.deployment}])`);
    } catch (err) {
      console.warn(`[BUILD-META] Skipped writing to ${relPath}:`, err.message);
    }
  }

  return meta;
}

// Auto-run when executed directly from CLI
const currentFilePath = fileURLToPath(import.meta.url);
const isDirectExecution =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(currentFilePath);

if (isDirectExecution) {
  writeBuildMetadata();
}
