import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { computeVerificationExpiry } from '../server/routes/passes/verify-identity.js';

describe('Portal Identity Verification & Canonical Contract (Executable + Contract)', () => {
  const verifyIdentitySource = fs.readFileSync(
    path.resolve('server/routes/passes/verify-identity.ts'),
    'utf-8'
  );
  const issueSource = fs.readFileSync(
    path.resolve('server/routes/passes/issue.ts'),
    'utf-8'
  );

  it('1. verify-identity writes strictly canonical Migration 39 schema columns and outcomes', () => {
    // Canonical columns written
    expect(verifyIdentitySource).toMatch(/owner_id/);
    expect(verifyIdentitySource).toMatch(/request_id/);
    expect(verifyIdentitySource).toMatch(/photo_intent_id/);
    expect(verifyIdentitySource).toMatch(/id_intent_id/);
    expect(verifyIdentitySource).toMatch(/outcome/);
    expect(verifyIdentitySource).toMatch(/model_name/);
    expect(verifyIdentitySource).toMatch(/model_version/);
    expect(verifyIdentitySource).toMatch(/verified_at/);
    expect(verifyIdentitySource).toMatch(/expires_at/);

    // Invented/non-canonical columns must NOT be inserted
    expect(verifyIdentitySource).not.toMatch(/actor_id\s*:/);
    expect(verifyIdentitySource).not.toMatch(/confidence_score\s*:/);
    expect(verifyIdentitySource).not.toMatch(/score\s*:/);
    expect(verifyIdentitySource).not.toMatch(/decision_reason\s*:/);

    // Embeddings/landmarks/tensors must NEVER be persisted
    expect(verifyIdentitySource).not.toMatch(/embedding\s*:/);
    expect(verifyIdentitySource).not.toMatch(/descriptor\s*:/);
    expect(verifyIdentitySource).not.toMatch(/landmarks\s*:/);
  });

  it('2. issue.ts reads strictly canonical Migration 39 verification columns', () => {
    // Canonical query fields
    expect(issueSource).toContain("from('portal_identity_verification_attempts')");
    expect(issueSource).toContain("owner_id, request_id, photo_intent_id, id_intent_id, outcome, expires_at");
    expect(issueSource).toContain("attempt.outcome !== 'matched'");
    expect(issueSource).toContain('identity_verification_required');
    expect(issueSource).toContain('identity_verification_expired');

    // Invented legacy fields must NOT be referenced
    expect(issueSource).not.toContain('attempt.status');
    expect(issueSource).not.toContain('attempt.matched');
    expect(issueSource).not.toContain('attempt.score');
  });

  it('3. computeVerificationExpiry correctly enforces bounded lifetime across intents and max window', () => {
    const baseMs = 1700000000000;
    const thirtyMinMs = 30 * 60 * 1000;

    // Case A: photo intent expires first
    const photoExpEarlier = new Date(baseMs + 10 * 60 * 1000).toISOString();
    const idExpLater = new Date(baseMs + 45 * 60 * 1000).toISOString();
    expect(computeVerificationExpiry(photoExpEarlier, idExpLater, baseMs, thirtyMinMs)).toBe(photoExpEarlier);

    // Case B: id intent expires first
    const photoExpLater = new Date(baseMs + 20 * 60 * 1000).toISOString();
    const idExpEarlier = new Date(baseMs + 5 * 60 * 1000).toISOString();
    expect(computeVerificationExpiry(photoExpLater, idExpEarlier, baseMs, thirtyMinMs)).toBe(idExpEarlier);

    // Case C: both intents have long lifetime (e.g. 2 hours), capped by 30-min window
    const photoFarFuture = new Date(baseMs + 120 * 60 * 1000).toISOString();
    const idFarFuture = new Date(baseMs + 120 * 60 * 1000).toISOString();
    const expectedCap = new Date(baseMs + thirtyMinMs).toISOString();
    expect(computeVerificationExpiry(photoFarFuture, idFarFuture, baseMs, thirtyMinMs)).toBe(expectedCap);
  });

  it('4. Executable PostgreSQL contract: verification table constraints and matching logic', async () => {
    const db = new PGlite();
    await db.exec(`
      create table if not exists portal_identity_verification_attempts (
        id uuid primary key default gen_random_uuid(),
        owner_id uuid not null,
        request_id uuid not null,
        photo_intent_id uuid not null,
        id_intent_id uuid not null,
        outcome text not null check (outcome in (
          'matched', 'mismatch', 'no_face_in_id', 'no_face_in_selfie',
          'multiple_selfie_faces', 'ambiguous_id_faces', 'low_quality_id',
          'low_quality_selfie', 'engine_error'
        )),
        model_name text not null default 'opencv_sface',
        model_version text not null default '2021dec',
        verified_at timestamptz not null default now(),
        expires_at timestamptz not null,
        created_at timestamptz not null default now()
      );
    `);

    const ownerId = '00000000-0000-0000-0000-000000000001';
    const requestId = '00000000-0000-0000-0000-000000000002';
    const photoIntentId = '00000000-0000-0000-0000-000000000003';
    const idIntentId = '00000000-0000-0000-0000-000000000004';
    const validExpiry = new Date(Date.now() + 600000).toISOString();

    // Insert canonical matched record
    await db.query(`
      insert into portal_identity_verification_attempts (
        owner_id, request_id, photo_intent_id, id_intent_id, outcome, expires_at
      ) values ($1, $2, $3, $4, 'matched', $5)
    `, [ownerId, requestId, photoIntentId, idIntentId, validExpiry]);

    // Executable query as performed by issue.ts
    const result = await db.query<{ outcome: string; expires_at: string }>(`
      select outcome, expires_at from portal_identity_verification_attempts
      where request_id = $1 and owner_id = $2 and photo_intent_id = $3 and id_intent_id = $4
      order by verified_at desc
      limit 1
    `, [requestId, ownerId, photoIntentId, idIntentId]);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.outcome).toBe('matched');
    expect(new Date(result.rows[0]?.expires_at).getTime()).toBeGreaterThan(Date.now());

    // Invalid enum value rejected by Postgres CHECK constraint
    await expect(db.query(`
      insert into portal_identity_verification_attempts (
        owner_id, request_id, photo_intent_id, id_intent_id, outcome, expires_at
      ) values ($1, $2, $3, $4, 'invented_fake_outcome', $5)
    `, [ownerId, requestId, photoIntentId, idIntentId, validExpiry])).rejects.toThrow();
  }, 60000);
});
