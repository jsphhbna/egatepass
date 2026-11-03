#!/usr/bin/env node
/**
 * scripts/generate-returning-secrets.mjs
 *
 * Secure key and threshold generator for Returning Visitor 1:1 biometrics.
 * Generates cryptographically strong random material for:
 *   - RETURNING_VISITOR_TEMPLATE_KEY (AES-256-GCM 32-byte key in 64-char hex)
 *   - RETURNING_MATCH_TOKEN_SECRET (HMAC-SHA256 32-byte secret in 64-char hex)
 *
 * Configures the provisional OpenCV SFace reference threshold (0.363).
 *
 * Usage:
 *   node scripts/generate-returning-secrets.mjs --dry-run
 *   node scripts/generate-returning-secrets.mjs --write-env
 *   node scripts/generate-returning-secrets.mjs --show-instructions
 */

import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const PROVISIONAL_SFACE_THRESHOLD = '0.363';
export const PROVISIONAL_THRESHOLD_MODE = 'provisional';
export const DEFAULT_KEY_VERSION = 'v1';

export function generateCryptoSecrets() {
  const templateKey = randomBytes(32).toString('hex'); // 64 hex characters = 32 bytes
  const matchSecret = randomBytes(32).toString('hex'); // 64 hex characters = 32 bytes
  return {
    templateKey,
    matchSecret,
    minCosine: PROVISIONAL_SFACE_THRESHOLD,
    thresholdMode: PROVISIONAL_THRESHOLD_MODE,
    keyVersion: DEFAULT_KEY_VERSION,
  };
}

export function maskSecretSummary(secret) {
  if (!secret) return 'missing';
  const hash = createHash('sha256').update(secret).digest('hex').slice(0, 8);
  return `length=${secret.length}, sha256_prefix=${hash}`;
}

export function updateEnvLocalFile(envPath = '.env.local') {
  const resolvedPath = path.resolve(envPath);
  let existingContent = '';
  if (fs.existsSync(resolvedPath)) {
    existingContent = fs.readFileSync(resolvedPath, 'utf8');
  }

  const generated = generateCryptoSecrets();
  const lines = existingContent.split(/\r?\n/);
  const updatedLines = [];
  const foundKeys = new Set();

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const key = trimmed.split('=')[0].trim();
      foundKeys.add(key);
    }
    updatedLines.push(line);
  }

  const additions = [];
  if (!foundKeys.has('RETURNING_VISITOR_TEMPLATE_KEY')) {
    additions.push(`RETURNING_VISITOR_TEMPLATE_KEY=${generated.templateKey}`);
  }
  if (!foundKeys.has('RETURNING_MATCH_TOKEN_SECRET')) {
    additions.push(`RETURNING_MATCH_TOKEN_SECRET=${generated.matchSecret}`);
  }
  if (!foundKeys.has('RETURNING_FACE_MIN_COSINE')) {
    additions.push(`RETURNING_FACE_MIN_COSINE=${generated.minCosine}`);
  }
  if (!foundKeys.has('RETURNING_FACE_THRESHOLD_MODE')) {
    additions.push(`RETURNING_FACE_THRESHOLD_MODE=${generated.thresholdMode}`);
  }
  if (!foundKeys.has('RETURNING_VISITOR_ACTIVE_KEY_VERSION')) {
    additions.push(`RETURNING_VISITOR_ACTIVE_KEY_VERSION=${generated.keyVersion}`);
  }

  if (additions.length > 0) {
    if (updatedLines.length > 0 && updatedLines[updatedLines.length - 1].trim() !== '') {
      updatedLines.push('');
    }
    updatedLines.push('# Returning Visitor 1:1 Biometrics & AES-256-GCM Template Security (Provisional Mode)');
    updatedLines.push(...additions);
    fs.writeFileSync(resolvedPath, updatedLines.join('\n'), 'utf8');
  }

  return {
    addedCount: additions.length,
    preservedCount: 5 - additions.length,
  };
}

// CLI entrypoint if executed directly
if (process.argv[1] && process.argv[1].endsWith('generate-returning-secrets.mjs')) {
  const args = process.argv.slice(2);
  const isWrite = args.includes('--write-env');
  const isInstructions = args.includes('--show-instructions');

  console.log('=== E-GatePass Returning Visitor Biometric Secrets Manager ===');

  if (isWrite) {
    const result = updateEnvLocalFile('.env.local');
    console.log(`[SUCCESS] .env.local updated: ${result.addedCount} new variables added, ${result.preservedCount} preserved.`);
  }

  const currentTemplateKey = process.env.RETURNING_VISITOR_TEMPLATE_KEY;
  const currentMatchSecret = process.env.RETURNING_MATCH_TOKEN_SECRET;

  console.log(`- Template Key Status: ${maskSecretSummary(currentTemplateKey)}`);
  console.log(`- Match Token Secret Status: ${maskSecretSummary(currentMatchSecret)}`);
  console.log(`- Threshold: ${PROVISIONAL_SFACE_THRESHOLD} (${PROVISIONAL_THRESHOLD_MODE})`);

  if (isInstructions || !isWrite) {
    console.log('\n--- Vercel Environment Configuration Instructions ---');
    console.log('To activate Returning Visitor verification on Vercel:');
    console.log('1. Open Vercel Dashboard -> Project (egatepass) -> Settings -> Environment Variables.');
    console.log('2. Add the following environment variables (Target: Production & Preview):');
    console.log('   - RETURNING_VISITOR_TEMPLATE_KEY: 64-character hexadecimal key (AES-256-GCM)');
    console.log('   - RETURNING_MATCH_TOKEN_SECRET: 64-character hexadecimal secret (HMAC-SHA256)');
    console.log('   - RETURNING_FACE_MIN_COSINE: 0.363');
    console.log('   - RETURNING_FACE_THRESHOLD_MODE: provisional');
    console.log('   - RETURNING_VISITOR_ACTIVE_KEY_VERSION: v1');
    console.log('3. Trigger a redeployment in Vercel to pick up the new variables.\n');
  }
}
