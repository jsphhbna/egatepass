import { describe, it, expect, vi, beforeEach } from 'vitest';
import { handleRequest } from '../server/routes/passes/request-office-visit.js';
import { createEmailVerificationProofToken } from '../server/lib/office.js';
import { computeMatchTokenDigest } from '../server/routes/passes/identify-returning.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';

vi.mock('../server/upload-inspection.js', () => ({
  inspectUploadIntent: vi.fn().mockImplementation(async (_admin, id, _actorId, _source, _kind) => {
    if (id === '00000000-0000-4000-8000-000000000099') throw new Error('invalid_upload_intent');
    return { bytes: 2048, sha256: 'a'.repeat(64) };
  }),
}));

vi.mock('../server/actors.js', () => ({
  getVerifiedSessionContext: vi.fn().mockImplementation(async (_admin, token) => {
    if (token === 'recovery-token') {
      return {
        user: { id: '00000000-0000-4000-8000-000000000001', is_anonymous: true },
        isRecoverySession: true,
      };
    }
    return {
      user: { id: '00000000-0000-4000-8000-000000000001', is_anonymous: true },
      isRecoverySession: false,
    };
  }),
  HttpError: class HttpError extends Error {
    constructor(public status: number, public code: string) {
      super(code);
    }
  },
}));

describe('Office Visit Identity Trust Boundary', () => {
  const actorId = '00000000-0000-4000-8000-000000000001';
  const officeId = '00000000-0000-4000-8000-000000000011';
  const personnelId = '00000000-0000-4000-8000-000000000022';
  const photoIntentId = '00000000-0000-4000-8000-000000000033';
  const idIntentId = '00000000-0000-4000-8000-000000000044';
  const profileId = '00000000-0000-4000-8000-000000000055';
  const identityAttemptId = '00000000-0000-4000-8000-000000000066';
  const returningAttemptId = '00000000-0000-4000-8000-000000000077';
  const matchToken = 'c'.repeat(64);
  const visitorEmail = 'visitor@example.com';

  let mockVerificationAttempts: any[] = [];
  let mockReturningAttempts: any[] = [];
  let rpcCalls: any[] = [];

  beforeEach(() => {
    process.env.OFFICE_VISIT_HMAC_SECRET = 'a'.repeat(32);
    process.env.RETURNING_MATCH_TOKEN_SECRET = 'b'.repeat(32);

    mockVerificationAttempts = [];
    mockReturningAttempts = [];
    rpcCalls = [];

    const mockAdmin: any = {
      from: (table: string) => {
        const filters: Array<(row: any) => boolean> = [];
        const chain: any = {
          select: () => chain,
          eq: (col: string, val: any) => {
            filters.push((row) => row[col] === val);
            return chain;
          },
          gt: (col: string, val: any) => {
            filters.push((row) => row[col] > val);
            return chain;
          },
          order: () => chain,
          limit: () => chain,
          maybeSingle: async () => {
            if (table === 'offices') {
              return { data: { id: officeId, name: 'Office of the Registrar', active: true }, error: null };
            }
            if (table === 'office_personnel') {
              return { data: { id: personnelId, office_id: officeId, name: 'Registrar Staff', active: true }, error: null };
            }
            if (table === 'portal_identity_verification_attempts') {
              const matched = mockVerificationAttempts.filter((r) => filters.every((f) => f(r)));
              return { data: matched[0] ?? null, error: null };
            }
            if (table === 'returning_identity_attempts') {
              const matched = mockReturningAttempts.filter((r) => filters.every((f) => f(r)));
              return { data: matched[0] ?? null, error: null };
            }
            return { data: null, error: null };
          },
        };
        return chain;
      },
      schema: (schemaName: string) => ({
        rpc: vi.fn(async (fnName: string, args: any) => {
          rpcCalls.push({ schemaName, fnName, args });
          return {
            data: {
              ok: true,
              visit_id: '00000000-0000-4000-8000-000000000088',
              reference_code: 'OVR-20261107-0001',
              approval_status: 'pending',
              attendance_status: 'awaiting_entry',
            },
            error: null,
          };
        }),
      }),
      rpc: vi.fn(async (fnName: string, args: any) => {
        rpcCalls.push({ schemaName: 'public', fnName, args });
        return {
          data: {
            ok: true,
            visit_id: '00000000-0000-4000-8000-000000000088',
            reference_code: 'OVR-20261107-0001',
            approval_status: 'pending',
            attendance_status: 'awaiting_entry',
          },
          error: null,
        };
      }),
    };

    setServerSupabaseClientsForTest({
      admin: mockAdmin,
      anon: {} as any,
    });
  });

  function makeRequest(body: any, token = 'valid-token') {
    return new Request('https://egatepass.tech/api/request-office-visit', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
  }

  function getBasePayload() {
    return {
      requestId: '00000000-0000-4000-8000-000000000002',
      visitor: {
        firstName: 'Juan',
        lastName: 'Dela Cruz',
        contactNumber: '09171234567',
        email: visitorEmail,
        purpose: 'Academic consultation',
        visitDate: '2026-11-10',
      },
      officeId,
      personnelId,
      specificPurpose: 'Academic consultation with Dean',
    };
  }

  it('1. Rejects request without authentication token', async () => {
    const req = new Request('https://egatepass.tech/api/request-office-visit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(401);
  });

  it('2. Rejects request with invalid or expired email verification proof token', async () => {
    const req = makeRequest({
      ...getBasePayload(),
      emailVerificationToken: 'invalid_token',
      registrationMode: 'new',
      photoIntentId,
      idIntentId,
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('email_verification_invalid');
  });

  it('3. Rejects new visitor request missing mandatory photo or ID intent', async () => {
    const emailVerificationToken = createEmailVerificationProofToken(visitorEmail, actorId);
    const req = makeRequest({
      ...getBasePayload(),
      emailVerificationToken,
      registrationMode: 'new',
      photoIntentId,
      // Missing idIntentId
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('identity_proof_required');
  });

  it('4. Rejects new visitor request with returning metadata attached', async () => {
    const emailVerificationToken = createEmailVerificationProofToken(visitorEmail, actorId);
    const req = makeRequest({
      ...getBasePayload(),
      emailVerificationToken,
      registrationMode: 'new',
      photoIntentId,
      idIntentId,
      returning: {
        profileId,
        matchToken,
      },
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('returning_metadata_forbidden');
  });

  it('5. Rejects returning visitor request missing returning profile or match token', async () => {
    const emailVerificationToken = createEmailVerificationProofToken(visitorEmail, actorId);
    const req = makeRequest({
      ...getBasePayload(),
      emailVerificationToken,
      registrationMode: 'returning',
      // Missing returning object
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('returning_credentials_required');
  });

  it('6. Rejects new visitor without unexpired matched biometric verification attempt', async () => {
    const emailVerificationToken = createEmailVerificationProofToken(visitorEmail, actorId);
    // mockVerificationAttempts is empty -> no verified attempt
    const req = makeRequest({
      ...getBasePayload(),
      emailVerificationToken,
      registrationMode: 'new',
      photoIntentId,
      idIntentId,
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('identity_verification_required');
  });

  it('7. Rejects returning visitor without unexpired matched returning identity attempt', async () => {
    const emailVerificationToken = createEmailVerificationProofToken(visitorEmail, actorId);
    // mockReturningAttempts is empty -> no verified attempt
    const req = makeRequest({
      ...getBasePayload(),
      emailVerificationToken,
      registrationMode: 'returning',
      returning: {
        profileId,
        matchToken,
      },
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('returning_match_required');
  });

  it('8. Accepts verified new visitor and binds identity verification record to RPC', async () => {
    const basePayload = getBasePayload();
    const emailVerificationToken = createEmailVerificationProofToken(visitorEmail, actorId);
    mockVerificationAttempts.push({
      id: identityAttemptId,
      owner_id: actorId,
      request_id: basePayload.requestId,
      photo_intent_id: photoIntentId,
      id_intent_id: idIntentId,
      outcome: 'matched',
      expires_at: new Date(Date.now() + 600000).toISOString(),
    });

    const req = makeRequest({
      ...basePayload,
      emailVerificationToken,
      registrationMode: 'new',
      photoIntentId,
      idIntentId,
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.visitId).toBe('00000000-0000-4000-8000-000000000088');

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].schemaName).toBe('api');
    expect(rpcCalls[0].fnName).toBe('create_specific_person_visit_request');
    expect(rpcCalls[0].args.requested_registration_mode).toBe('new');
    expect(rpcCalls[0].args.requested_identity_verification_id).toBe(identityAttemptId);
    expect(rpcCalls[0].args.requested_returning_profile_id).toBeNull();
  });

  it('9. Accepts verified returning visitor and binds returning attempt and profile ID to RPC', async () => {
    const basePayload = getBasePayload();
    const emailVerificationToken = createEmailVerificationProofToken(visitorEmail, actorId);
    const matchDigest = computeMatchTokenDigest(matchToken, process.env.RETURNING_MATCH_TOKEN_SECRET!);
    mockReturningAttempts.push({
      id: returningAttemptId,
      owner_id: actorId,
      request_id: basePayload.requestId,
      matched_profile_id: profileId,
      match_token_digest: matchDigest,
      outcome: 'matched',
      expires_at: new Date(Date.now() + 600000).toISOString(),
    });

    const req = makeRequest({
      ...basePayload,
      emailVerificationToken,
      registrationMode: 'returning',
      returning: {
        profileId,
        matchToken,
      },
    });
    const res = await handleRequest(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].schemaName).toBe('api');
    expect(rpcCalls[0].fnName).toBe('create_specific_person_visit_request');
    expect(rpcCalls[0].args.requested_registration_mode).toBe('returning');
    expect(rpcCalls[0].args.requested_returning_attempt_id).toBe(returningAttemptId);
    expect(rpcCalls[0].args.requested_returning_profile_id).toBe(profileId);
    expect(rpcCalls[0].args.requested_identity_verification_id).toBeNull();
  });
});
