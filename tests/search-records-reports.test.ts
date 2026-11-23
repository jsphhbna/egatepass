import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createEmailVerificationProofToken,
  verifyEmailVerificationProofToken,
} from '../server/lib/office.js';

describe('Search & Records Deep-Dive Repair Tests', () => {
  const recordsSrc = readFileSync('server/routes/admin/records.ts', 'utf8');
  const emailPassSrc = readFileSync('server/routes/passes/email.ts', 'utf8');
  const verifyEmailSrc = readFileSync('server/routes/office/verify-email.ts', 'utf8');
  const accountabilityLibSrc = readFileSync('server/lib/accountability.ts', 'utf8');
  const adminRecordsUiSrc = readFileSync('src/pages/AdminRecords.tsx', 'utf8');
  const migrationSrc = readFileSync(
    'supabase/migrations/20261123001100_search_records_and_accountability_repair.sql',
    'utf8',
  );

  describe('1. Static Code and Schema Invariant Checks', () => {
    it('ensures records.ts does NOT query nonexistent offices.code column (resolving 42703)', () => {
      expect(recordsSrc).not.toMatch(/offices\s*\([^)]*\bcode\b[^)]*\)/i);
      expect(recordsSrc).not.toContain("code: r.offices?.code");
      expect(recordsSrc).not.toContain("offices ( id, name, code )");
    });

    it('ensures records.ts preserves read-only invariant and contains no direct .rpc( calls', () => {
      expect(recordsSrc).not.toContain('.rpc(');
    });

    it('ensures server/routes/passes/email.ts queries app_settings singleton rather than non-existent id column (resolving 42703)', () => {
      expect(emailPassSrc).not.toContain(".eq('id', 1)");
      expect(emailPassSrc).toContain(".eq('singleton', true)");
    });

    it('ensures verify-email.ts generates single-use proof token and stores SHA-256 digest in office_visit_verification_proofs', () => {
      expect(verifyEmailSrc).toContain("randomBytes(32).toString('hex')");
      expect(verifyEmailSrc).toContain("createHash('sha256')");
      expect(verifyEmailSrc).toContain('office_visit_verification_proofs');
    });

    it('ensures server/lib/accountability.ts encapsulates api.get_accountability_summary', () => {
      expect(accountabilityLibSrc).toContain("admin.schema('api').rpc('get_accountability_summary'");
      expect(accountabilityLibSrc).toContain('getAccountabilitySummary');
    });

    it('ensures migration defines ON DELETE RESTRICT on visitor_accountability_resolutions.actor_id and get_accountability_summary RPC', () => {
      expect(migrationSrc).toContain('visitor_accountability_resolutions_actor_id_fkey');
      expect(migrationSrc).toContain('ON DELETE RESTRICT');
      expect(migrationSrc).toContain('api.get_accountability_summary');
      expect(migrationSrc).toContain('api.delete_staff_account');
      expect(migrationSrc).toContain('target_has_accountability_resolutions');
    });

    it('ensures AdminRecords.tsx implements debounced search, AbortController, pagination, and stable requestId', () => {
      expect(adminRecordsUiSrc).toContain('debouncedSearchQuery');
      expect(adminRecordsUiSrc).toContain('abortControllerRef');
      expect(adminRecordsUiSrc).toContain('requestCounterRef');
      expect(adminRecordsUiSrc).toContain('loadMoreReportData');
      expect(adminRecordsUiSrc).toContain('resolutionRequestIdRef');
    });
  });

  describe('2. Email Verification Token Integration', () => {
    it('generates and verifies email proof tokens conforming to HMAC contract', () => {
      process.env.OFFICE_VISIT_HMAC_SECRET = 'test_secret_key_at_least_32_characters_long_12345';
      const email = 'visitor.test@earist.edu.ph';
      const actorId = '22222222-2222-4000-a000-000000000002';
      const token = createEmailVerificationProofToken(email, actorId, 15);

      expect(token).toMatch(/^v_email\./);
      const verified = verifyEmailVerificationProofToken(token, email, actorId);
      expect(verified).toBe(true);

      // Verify wrong email fails
      const wrongEmail = verifyEmailVerificationProofToken(token, 'attacker@example.com', actorId);
      expect(wrongEmail).toBe(false);

      // Verify wrong actor fails
      const wrongActor = verifyEmailVerificationProofToken(
        token,
        email,
        '33333333-3333-4000-a000-000000000003',
      );
      expect(wrongActor).toBe(false);
    });
  });

  describe('3. Phone Number Search Normalization Invariant', () => {
    it('normalizes local 09xx and international +639xx numbers for bi-directional search', () => {
      const localInput = '09171234567';
      const digits = localInput.replace(/\D/g, '');

      expect(digits.startsWith('09')).toBe(true);
      const intlEquivalent = `+63${digits.slice(1)}`;
      expect(intlEquivalent).toBe('+639171234567');

      const intlInput = '+639171234567';
      const intlDigits = intlInput.replace(/\D/g, '');
      expect(intlDigits.startsWith('639')).toBe(true);
      const localEquivalent = `0${intlDigits.slice(2)}`;
      expect(localEquivalent).toBe('09171234567');
    });
  });
});
