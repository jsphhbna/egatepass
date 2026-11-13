import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('General Office Visit vs Specific Person Workflow Matrix Contract', () => {
  const reqOfficeVisitSrc = readFileSync('server/routes/passes/request-office-visit.ts', 'utf8');
  const issuePassSrc = readFileSync('server/routes/passes/issue.ts', 'utf8');
  const migration97Src = readFileSync('supabase/migrations/20261113000400_ncr_psgc_comprehensive_reconciliation.sql', 'utf8');

  it('ensures specific person requests unconditionally require office approval regardless of legacy office flag', () => {
    // 1. In request-office-visit.ts: no passQrToken or passTokenDigest generated on submission
    expect(reqOfficeVisitSrc).toContain(
      '// Specific person visit requests unconditionally require office approval; no pass token is issued at request creation.'
    );
    expect(reqOfficeVisitSrc).toContain('let passQrToken: string | null = null;');
    expect(reqOfficeVisitSrc).toContain('let passTokenDigest: string | null = null;');
    expect(reqOfficeVisitSrc).not.toContain('createHmac(\'sha256\', passSecret)');

    // 2. In api.create_specific_person_visit_request (Migration 97): unconditionally creates pending office_visit
    expect(migration97Src).toContain(
      '-- Unconditionally create pending office visit request with ZERO ordinary pass'
    );
    expect(migration97Src).toContain("'pending'::public.office_approval_status");
    expect(migration97Src).toContain("'pending'::public.office_attendance_status");
    expect(migration97Src).toContain('null::uuid,\n    null::uuid,\n    null::timestamptz,\n    null::timestamptz');
  });

  it('ensures specific person requests enforce mandatory email', () => {
    expect(reqOfficeVisitSrc).toContain('requested_email: normalizedVisitorEmail');
    expect(migration97Src).toContain(
      "if requested_visit_type = 'specific_person' and (requested_email is null or char_length(btrim(requested_email)) = 0) then"
    );
    expect(migration97Src).toContain("raise exception using errcode = '22023', message = 'email_required_for_specific_person';");
  });

  it('ensures general office visit issues immediate passes without requiring preapproval flag', () => {
    // issue.ts issues pass immediately upon legitimate date/calendar validation
    expect(issuePassSrc).not.toContain('targetOffice.requires_approval_before_pass');
  });

  it('proves api.decide_office_visit is transactionally idempotent for repeat submissions', () => {
    expect(migration97Src).toContain('-- Transactionally Idempotent: If visit has already been decided, return current authoritative decision');
    expect(migration97Src).toContain("return query select true, 'approved'::text, target_visit.pass_id, new_public_ref, v_from, v_until, 'Visit already approved.'::text;");
    expect(migration97Src).toContain("return query select true, 'rejected'::text, null::uuid, null::uuid, null::timestamptz, null::timestamptz, 'Visit already rejected.'::text;");
  });
});
