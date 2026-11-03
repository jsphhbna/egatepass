#!/usr/bin/env node
/**
 * scripts/calibrate-returning-face.mjs
 *
 * Local-only face biometric calibration harness for 1:1 returning visitor verification.
 * Evaluates:
 * - Genuine match score distribution (intra-person similarity for the same subject across poses/lighting)
 * - Impostor score distribution (inter-person similarity between distinct subjects)
 * - Empirical False Accept Rate (FAR) and False Reject Rate (FRR) across candidate cosine thresholds
 * - Equal Error Rate (EER) and recommended operational threshold for RETURNING_FACE_MIN_COSINE
 *
 * NOTE:
 * - This script operates on local calibration sets only.
 * - Does NOT modify production environment variables or Supabase settings.
 * - Test images and local manifests must remain local and gitignored.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const args = process.argv.slice(2);
const manifestArg = args.find((a) => a.startsWith('--manifest='))?.split('=')[1] || args[0];

function printHeader() {
  console.log('================================================================');
  console.log('  E-GatePass Returning Visitor 1:1 Biometric Calibration Harness');
  console.log('  Engine: OpenCV Zoo YuNet (2023mar) + SFace (2021dec) 128-d');
  console.log('  Verification Mode: Strict 1:1 Pairwise Facial Comparison');
  console.log('================================================================\n');
}

function printStatusDiagnosis(manifestPath) {
  console.log(`[!] Calibration manifest '${manifestPath || 'none'}' not found or not provided.`);
  console.log('[*] Biometric Calibration & Safety Gate Assessment:\n');

  console.log('--- 1. VERIFICATION ARCHITECTURE ---');
  console.log('  Model: SFace 128-dimensional L2-normalized facial embeddings.');
  console.log('  Protocol: 1:1 verification directly comparing fresh selfie embedding');
  console.log('  against the selected returning visitor\'s encrypted reference template.');
  console.log('  Gallery 1:N searching and margin checks have been fully retired.');

  console.log('\n--- 2. EMPIRICAL CAMPUS CALIBRATION PREREQUISITE ---');
  console.log('  Physical subject calibration data has NOT yet been collected from actual');
  console.log('  EARIST campus gate cameras, optical angles, and representative lighting.');
  console.log('  Setting an arbitrary RETURNING_FACE_MIN_COSINE without empirical validation');
  console.log('  would violate campus security policies and risk false admissions or rejections.');

  console.log('\n--- 3. PRODUCTION SAFETY GATE STATUS ---');
  console.log('  Production environment variable RETURNING_FACE_MIN_COSINE must remain UNSET');
  console.log('  until empirical calibration is completed with real campus test subjects.');
  console.log('  Current System Behavior:');
  console.log('    - returningVisitorAvailable: false (Fail-closed)');
  console.log('    - Visitor UI reports: "Setup Pending"');
  console.log('    - Safety gate enforces full registration through standard 6-step New Visitor path.');

  console.log('\n--- 4. MANIFEST FORMAT FOR CAMPUS CALIBRATION ---');
  console.log('  Create a local manifest file (e.g. campus-calibration.manifest.json):');
  console.log(`  {
    "description": "EARIST Campus Entrance 1:1 Calibration Set",
    "subjects": [
      {
        "id": "subject_001",
        "descriptors": [
          [ 0.042, -0.015, ..., 0.089 ],  // Capture 1 (Enrollment / Morning)
          [ 0.039, -0.018, ..., 0.085 ]   // Capture 2 (Verification / Afternoon)
        ]
      },
      {
        "id": "subject_002",
        "descriptors": [ ... ]
      }
    ]
  }`);
  console.log('\n  Run calibration:');
  console.log('    node scripts/calibrate-returning-face.mjs --manifest=campus-calibration.manifest.json\n');
}

export function computeCosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const valA = a[i] ?? 0;
    const valB = b[i] ?? 0;
    dot += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (!Number.isFinite(denominator) || denominator < 1e-6) return 0;
  const sim = dot / denominator;
  return Number.isFinite(sim) ? Math.max(-1, Math.min(1, sim)) : 0;
}

export function computeDistributionStats(scores) {
  if (scores.length === 0) {
    return { count: 0, mean: 0, min: 0, max: 0, p10: 0, p50: 0, p90: 0 };
  }
  const sorted = [...scores].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const mean = sum / sorted.length;
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))] ?? 0;

  return {
    count: sorted.length,
    mean: Number(mean.toFixed(4)),
    min: Number((sorted[0] ?? 0).toFixed(4)),
    max: Number((sorted[sorted.length - 1] ?? 0).toFixed(4)),
    p10: Number(p(0.1).toFixed(4)),
    p50: Number(p(0.5).toFixed(4)),
    p90: Number(p(0.9).toFixed(4)),
  };
}

export function evaluatePairwiseMetrics(genuineScores, impostorScores) {
  const candidateThresholds = [];
  for (let t = 0.30; t <= 0.701; t += 0.02) {
    candidateThresholds.push(Number(t.toFixed(2)));
  }

  let minErrorDiff = Infinity;
  let eerThreshold = candidateThresholds[0];

  const table = candidateThresholds.map((t) => {
    const falseRejects = genuineScores.filter((s) => s < t).length;
    const falseAccepts = impostorScores.filter((s) => s >= t).length;

    const frr = genuineScores.length > 0 ? falseRejects / genuineScores.length : 0;
    const far = impostorScores.length > 0 ? falseAccepts / impostorScores.length : 0;

    const diff = Math.abs(frr - far);
    if (diff < minErrorDiff) {
      minErrorDiff = diff;
      eerThreshold = t;
    }

    return {
      threshold: t,
      frr: Number(frr.toFixed(4)),
      far: Number(far.toFixed(4)),
      falseRejects,
      falseAccepts,
    };
  });

  return {
    table,
    eerThreshold,
    minErrorDiff: Number(minErrorDiff.toFixed(4)),
  };
}

async function run() {
  printHeader();

  if (!manifestArg || !fs.existsSync(manifestArg)) {
    printStatusDiagnosis(manifestArg);
    process.exit(0);
  }

  const manifestContent = fs.readFileSync(manifestArg, 'utf8');
  let manifest;
  try {
    manifest = JSON.parse(manifestContent);
  } catch (err) {
    console.error(`[X] Failed to parse manifest JSON at '${manifestArg}':`, err.message);
    process.exit(1);
  }

  const subjects = manifest.subjects || [];
  if (subjects.length < 2) {
    console.error('[X] Manifest must contain at least 2 subjects with 2 or more captures each for 1:1 pairwise calibration.');
    process.exit(1);
  }

  console.log(`[*] Loaded ${subjects.length} subjects from ${path.basename(manifestArg)}.`);

  const genuineScores = [];
  const impostorScores = [];

  // 1. Collect genuine intra-person pairs
  for (const subject of subjects) {
    const descriptors = subject.descriptors || [];
    for (let i = 0; i < descriptors.length; i++) {
      for (let j = i + 1; j < descriptors.length; j++) {
        const sim = computeCosineSimilarity(descriptors[i], descriptors[j]);
        genuineScores.push(sim);
      }
    }
  }

  // 2. Collect impostor inter-person pairs
  for (let i = 0; i < subjects.length; i++) {
    for (let j = i + 1; j < subjects.length; j++) {
      const descA = subjects[i].descriptors || [];
      const descB = subjects[j].descriptors || [];
      for (const da of descA) {
        for (const db of descB) {
          const sim = computeCosineSimilarity(da, db);
          impostorScores.push(sim);
        }
      }
    }
  }

  console.log(`[*] Computed ${genuineScores.length} genuine intra-person pairs.`);
  console.log(`[*] Computed ${impostorScores.length} impostor inter-person pairs.\n`);

  const genuineStats = computeDistributionStats(genuineScores);
  const impostorStats = computeDistributionStats(impostorScores);

  console.log('--- 1. SCORE DISTRIBUTIONS ---');
  console.log('Genuine (Same Subject):');
  console.log(`  Count: ${genuineStats.count}`);
  console.log(`  Mean:  ${genuineStats.mean} (Min: ${genuineStats.min}, Max: ${genuineStats.max})`);
  console.log(`  P10:   ${genuineStats.p10}, Median (P50): ${genuineStats.p50}, P90: ${genuineStats.p90}`);

  console.log('\nImpostor (Different Subjects):');
  console.log(`  Count: ${impostorStats.count}`);
  console.log(`  Mean:  ${impostorStats.mean} (Min: ${impostorStats.min}, Max: ${impostorStats.max})`);
  console.log(`  P10:   ${impostorStats.p10}, Median (P50): ${impostorStats.p50}, P90: ${impostorStats.p90}`);

  const evaluation = evaluatePairwiseMetrics(genuineScores, impostorScores);

  console.log('\n--- 2. THRESHOLD SWEEP (FAR vs FRR) ---');
  console.log('Threshold | FRR (False Reject) | FAR (False Accept)');
  console.log('----------|--------------------|-------------------');
  for (const row of evaluation.table) {
    const isEer = row.threshold === evaluation.eerThreshold ? ' <-- Approx EER' : '';
    console.log(
      `  ${row.threshold.toFixed(2)}    |     ${(row.frr * 100).toFixed(2).padStart(5)}%       |     ${(row.far * 100).toFixed(2).padStart(5)}%${isEer}`
    );
  }

  console.log('\n--- 3. CALIBRATION RECOMMENDATION ---');
  console.log(`  Approximate EER Threshold: ${evaluation.eerThreshold.toFixed(2)}`);
  console.log(`  Recommended RETURNING_FACE_MIN_COSINE: ${(evaluation.eerThreshold + 0.02).toFixed(2)} (conservative safety bias)`);
  console.log('  To apply to staging/production once authorized:');
  console.log(`    export RETURNING_FACE_MIN_COSINE=${(evaluation.eerThreshold + 0.02).toFixed(2)}\n`);
}

// Only invoke run() when executed directly from CLI
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run().catch((err) => {
    console.error('Calibration execution error:', err);
    process.exit(1);
  });
}
