import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const handler = readFileSync('server/routes/passes/email.ts', 'utf8');
const emailAdapter = readFileSync('server/email.ts', 'utf8');
const modal = readFileSync('src/components/EmailPassModal.tsx', 'utf8');
const migrationPath = 'supabase/migrations/20261020001000_qr_email_security.sql';
const migration = existsSync(migrationPath) ? readFileSync(migrationPath, 'utf8') : '';

describe('QR-email security regression contract', () => {
  it('EMAIL-P0-01 fails closed without direct verification-table fallbacks', () => {
    expect(handler).not.toContain(".from('pass_email_verifications')");
    expect(handler).toContain("error: 'email_state_unavailable'");
  });

  it('EMAIL-P0-02 fences idempotent claim replays before provider dispatch', () => {
    expect(handler).toContain('respondToDispatchReplay');
    expect(handler).toContain('dispatch_authorized');
    expect(migration).toContain("'dispatch_authorized', false");
  });

  it('EMAIL-P0-03 serializes request-code rate limiting on the parent pass', () => {
    expect(migration).toMatch(/from public\.passes p[\s\S]+for update;/i);
    expect(migration).toContain('pass_email_verifications_pass_created_idx');
  });

  it('EMAIL-P0-04 preserves ambiguous provider outcomes and classifies adapter failures', () => {
    expect(handler).toContain("? 'delivery_failed' : 'outcome_unknown'");
    expect(emailAdapter).toContain("outcome: 'definitive_rejection' | 'unknown'");
    expect(migration).toContain("'outcome_unknown'");
  });

  it('EMAIL-P0-05 uses only a validated public UUID lookup and strict digest normalization', () => {
    expect(handler).toContain('z.string().uuid()');
    expect(handler).toContain(".eq('public_reference', parsed.data.passId)");
    expect(handler).not.toContain('.or(`public_reference.eq.');
    expect(handler).toContain('normalizeSha256Digest');
  });

  it('EMAIL-P1-06 keeps logical request IDs stable and uses provider-accurate wording', () => {
    expect(modal).toContain('requestCodeRequestIdRef');
    expect(modal).toContain('sendRequestIdRef');
    expect(modal).toContain('submitted to the email provider');
    expect(modal).not.toContain('Gate Pass QR delivered to your email!');
  });

  it('EMAIL-P1-07 hardens exact RPC grants and empty definer search paths additively', () => {
    expect(migration).toContain("set search_path = ''");
    expect(migration).toMatch(/revoke all on function api\.request_email_verification_code\([^)]+\) from public, anon, authenticated;/i);
    expect(migration).toMatch(/grant execute on function api\.finalize_email_dispatch\([^)]+\) to service_role;/i);
  });
});
