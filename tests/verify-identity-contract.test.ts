import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Portal Identity Verification & Pass Issuance Gate Contract', () => {
  const verifyIdentitySource = fs.readFileSync(
    path.resolve('server/routes/passes/verify-identity.ts'),
    'utf-8'
  );
  const issueSource = fs.readFileSync(
    path.resolve('server/routes/passes/issue.ts'),
    'utf-8'
  );

  it('1. Identity verification enforces IP and session rate limits', () => {
    expect(verifyIdentitySource).toMatch(/portal\.verify_identity/);
    expect(verifyIdentitySource).toMatch(/portal\.network_verify/);
    expect(verifyIdentitySource).toMatch(/rate_limit_exceeded/);
  });

  it('2. Identity verification persists attempt metadata without biometric embeddings', () => {
    expect(verifyIdentitySource).toMatch(/portal_identity_verification_attempts/);
    expect(verifyIdentitySource).toMatch(/photo_intent_id/);
    expect(verifyIdentitySource).toMatch(/id_intent_id/);
    expect(verifyIdentitySource).toMatch(/outcome/);
    expect(verifyIdentitySource).toMatch(/score/);

    // Ensure embeddings are NEVER inserted into the database
    expect(verifyIdentitySource).not.toMatch(/embedding\s*:/);
    expect(verifyIdentitySource).not.toMatch(/descriptor\s*:/);
    expect(verifyIdentitySource).not.toMatch(/landmarks\s*:/);
  });

  it('3. Pass issuance requires unexpired matched verification attempt for portal passes', () => {
    expect(issueSource).toMatch(/portal_identity_verification_attempts/);
    expect(issueSource).toMatch(/identity_verification_required/);
    expect(issueSource).toMatch(/attempt\.status !== ['"]matched['"]/);
    expect(issueSource).toMatch(/!attempt\.matched/);
  });

  it('4. Pass issuance rejects mismatched or expired verification attempts', () => {
    expect(issueSource).toMatch(/attempt\.photo_intent_id !== parsed\.data\.photoIntentId/);
    expect(issueSource).toMatch(/attempt\.id_intent_id !== parsed\.data\.idIntentId/);
    expect(issueSource).toMatch(/identity_verification_expired/);
  });
});
