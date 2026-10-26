import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let mockSession: any = null;
let actorCounter = 0;
let signOutCallCount = 0;
let storageUploadCount = 0;
let rpcCallCount = 0;
let rpcShouldFailOnCall: number | null = null;

vi.mock('../src/lib/supabase', () => {
  return {
    requirePortalSupabase: () => ({
      auth: {
        getSession: vi.fn(async () => ({ data: { session: mockSession }, error: null })),
        signOut: vi.fn(async () => {
          signOutCallCount++;
          mockSession = null;
          return { error: null };
        }),
        signInAnonymously: vi.fn(async () => {
          actorCounter++;
          const session = {
            user: { id: `actor-anon-${actorCounter}` },
            access_token: `token-anon-${actorCounter}`,
          };
          mockSession = session;
          return { data: { session }, error: null };
        }),
      },
      schema: (_s: string) => ({
        rpc: (_fn: string, args: any) => ({
          single: async () => {
            rpcCallCount++;
            if (rpcShouldFailOnCall === rpcCallCount) {
              return { data: null, error: { message: 'storage_timeout' } };
            }
            const intentId = `intent-${args.requested_kind}-${rpcCallCount}`;
            return {
              data: {
                intent_id: intentId,
                bucket_id: args.requested_kind === 'photo' ? 'visitor-photos' : 'visitor-ids',
                object_path: `intents/${intentId}.webp`,
                max_bytes: 5 * 1024 * 1024,
              },
              error: null,
            };
          },
        }),
      }),
      storage: {
        from: (_bucket: string) => ({
          upload: vi.fn(async () => {
            storageUploadCount++;
            return { data: { path: 'uploaded.webp' }, error: null };
          }),
        }),
      },
    }),
    requireSupabase: () => ({
      auth: {
        getSession: vi.fn(async () => ({ data: { session: mockSession }, error: null })),
      },
    }),
  };
});

import {
  createPortalIssueTransaction,
  issueVisitorPass,
  classifySubmissionOutcome,
} from '../src/services/visitorRegistration';
import type { VisitorRegistration } from '../src/types';

describe('Repair Group 1: Portal Issuance Transaction Identity & Idempotent Retry', () => {
  const dummyVisitor: VisitorRegistration = {
    firstName: 'Juan',
    lastName: 'Dela Cruz',
    email: 'juan@example.com',
    contactNumber: '09171234567',
    purpose: 'Academic Inquiry',
    visitDate: '2026-10-27',
    consent: true,
  };

  const photoBlob = new Blob(['fake-photo'], { type: 'image/webp' });
  const idBlob = new Blob(['fake-id'], { type: 'image/webp' });

  let issueDispatchCount = 0;

  beforeEach(() => {
    mockSession = null;
    actorCounter = 0;
    signOutCallCount = 0;
    storageUploadCount = 0;
    rpcCallCount = 0;
    rpcShouldFailOnCall = null;
    issueDispatchCount = 0;

    (import.meta as any).env = {
      ...(import.meta as any).env,
      VITE_TURNSTILE_SITE_KEY: 'test-key',
      PROD: false,
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ADVERSARIAL CASE A: Reuses actor, requestId, and upload intents across dropped-response retry', async () => {
    const committedPass = {
      passId: 'pass-uuid-1',
      qrToken: 'qr-token-1',
      publicReference: 'EP-20261027-001',
      validFrom: '2026-10-27T08:00:00Z',
      validUntil: '2026-10-27T17:00:00Z',
    };

    let receivedRequestIds: string[] = [];
    let receivedActors: string[] = [];
    let receivedPayloads: any[] = [];

    const globalFetch = vi.fn(async (url: string, init?: any) => {
      if (url.includes('/api/passes/issue')) {
        issueDispatchCount++;
        const authHeader = init?.headers?.Authorization || '';
        const actorToken = authHeader.replace('Bearer ', '');
        receivedActors.push(actorToken);

        const body = JSON.parse(init?.body || '{}');
        receivedRequestIds.push(body.requestId);
        receivedPayloads.push(body);

        if (issueDispatchCount === 1) {
          // Pass is committed in database, but HTTP transport response is dropped
          throw new TypeError('Failed to fetch (network drop after commit)');
        }

        // On retry, server validates idempotency and returns existing committed pass
        return {
          ok: true,
          json: async () => committedPass,
        };
      }

      return { ok: true, json: async () => ({}) };
    });

    vi.stubGlobal('fetch', globalFetch);

    // Establish initial portal transaction
    const transaction = await createPortalIssueTransaction();
    const originalActorId = transaction.actorId;
    const originalRequestId = transaction.requestId;
    expect(originalActorId).toBe('actor-anon-1');

    // First attempt: network fails after commit
    let firstError: Error | null = null;
    try {
      await issueVisitorPass('portal', dummyVisitor, photoBlob, idBlob, transaction.requestId, undefined, transaction);
    } catch (e) {
      firstError = e as Error;
    }
    expect(firstError).not.toBeNull();
    expect(issueDispatchCount).toBe(1);
    expect(rpcCallCount).toBe(2); // 1 photo intent, 1 ID intent
    expect(storageUploadCount).toBe(2);
    expect(transaction.photoIntentId).toBe('intent-photo-1');
    expect(transaction.idIntentId).toBe('intent-id-2');

    // Sign out should not have been called during retry preparation
    const signOutsBeforeRetry = signOutCallCount;

    // Retry attempt with same transaction: must NOT re-upload, must NOT sign out actor
    const retryResult = await issueVisitorPass(
      'portal',
      dummyVisitor,
      photoBlob,
      idBlob,
      transaction.requestId,
      undefined,
      transaction
    );

    // Assert retry success
    expect(retryResult.passId).toBe('pass-uuid-1');
    expect(retryResult.qrToken).toBe('qr-token-1');

    // Assert invariants:
    // 1. RPC upload intents were NOT re-created on retry
    expect(rpcCallCount).toBe(2);
    // 2. Storage upload was NOT repeated
    expect(storageUploadCount).toBe(2);
    // 3. No extra sign-out occurred
    expect(signOutCallCount).toBe(signOutsBeforeRetry);
    // 4. Same requestId was replayed
    expect(receivedRequestIds).toEqual([originalRequestId, originalRequestId]);
    // 5. Same actor token was replayed
    expect(receivedActors[0]).toBe(transaction.token);
    expect(receivedActors[1]).toBe(transaction.token);
    expect(transaction.actorId).toBe(originalActorId);
    // 6. Same payload was replayed
    expect(receivedPayloads[0].photoIntentId).toBe('intent-photo-1');
    expect(receivedPayloads[1].photoIntentId).toBe('intent-photo-1');
    expect(receivedPayloads[0].idIntentId).toBe('intent-id-2');
    expect(receivedPayloads[1].idIntentId).toBe('intent-id-2');
  });

  it('Partial upload failure: preserves successful photo intent and only retries missing ID intent', async () => {
    // Fail on the 2nd RPC call (ID intent creation)
    rpcShouldFailOnCall = 2;

    const globalFetch = vi.fn(async (url: string) => {
      if (url.includes('/api/passes/issue')) {
        return {
          ok: true,
          json: async () => ({ passId: 'p1', qrToken: 't1' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    vi.stubGlobal('fetch', globalFetch);

    const transaction = await createPortalIssueTransaction();

    // First attempt fails during ID upload
    await expect(
      issueVisitorPass('portal', dummyVisitor, photoBlob, idBlob, transaction.requestId, undefined, transaction)
    ).rejects.toThrow('Image upload could not be authorized.');

    expect(transaction.photoIntentId).toBe('intent-photo-1');
    expect(transaction.idIntentId).toBeNull();
    expect(rpcCallCount).toBe(2); // photo succeeded, ID failed

    // Clear failure for retry
    rpcShouldFailOnCall = null;

    // Retry: photo should NOT be re-uploaded, only ID upload should execute
    const result = await issueVisitorPass(
      'portal',
      dummyVisitor,
      photoBlob,
      idBlob,
      transaction.requestId,
      undefined,
      transaction
    );

    expect(result.passId).toBe('p1');
    expect(transaction.photoIntentId).toBe('intent-photo-1');
    expect(transaction.idIntentId).toBe('intent-id-3');
    expect(rpcCallCount).toBe(3); // only 1 additional RPC call was performed (for ID)
  });

  it('Register Another Pass: establishes a fresh transaction and does not reuse prior actor or intents', async () => {
    const tx1 = await createPortalIssueTransaction();
    expect(tx1.actorId).toBe('actor-anon-1');
    tx1.photoIntentId = 'intent-old-photo';
    tx1.idIntentId = 'intent-old-id';

    // Starting a new registration transaction signs out stale session and establishes new identity
    const tx2 = await createPortalIssueTransaction();

    expect(signOutCallCount).toBeGreaterThan(0);
    expect(tx2.actorId).toBe('actor-anon-2');
    expect(tx2.requestId).not.toBe(tx1.requestId);
    expect(tx2.photoIntentId).toBeNull();
    expect(tx2.idIntentId).toBeNull();
    expect(tx2.submittedPayload).toBeNull();
  });

  it('Portal B: Ambiguous submission locks payload, sets phase to ambiguous, and disallows silent modification on replay', async () => {
    let receivedPayloads: any[] = [];
    const globalFetch = vi.fn(async (url: string, init?: any) => {
      if (url.includes('/api/passes/issue')) {
        const body = JSON.parse(init?.body || '{}');
        receivedPayloads.push(body);
        if (receivedPayloads.length === 1) {
          // Transport drop / ambiguous outcome
          throw new TypeError('Failed to fetch');
        }
        return {
          ok: true,
          json: async () => ({ passId: 'pass-locked-1', qrToken: 'qr-locked-1' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', globalFetch);

    const transaction = await createPortalIssueTransaction();
    expect(transaction.phase).toBe('editable');

    const originalVisitor = { ...dummyVisitor, firstName: 'OriginalFirst' };

    // 1. Initial attempt fails ambiguously
    await expect(
      issueVisitorPass('portal', originalVisitor, photoBlob, idBlob, transaction.requestId, undefined, transaction)
    ).rejects.toThrow('Generation result could not be confirmed');

    // Invariant: Transaction transitioned to ambiguous state and froze submitted payload
    expect(transaction.phase).toBe('ambiguous');
    expect(transaction.submittedPayload?.visitor.firstName).toBe('OriginalFirst');

    // 2. An adversarial attempt to pass altered payload while transaction is ambiguous
    const silentlyAlteredVisitor = { ...dummyVisitor, firstName: 'TamperedFirst' };
    const result = await issueVisitorPass(
      'portal',
      silentlyAlteredVisitor,
      photoBlob,
      idBlob,
      transaction.requestId,
      undefined,
      transaction
    );

    // Invariant: The server request truthfully resent the frozen original payload!
    expect(result.passId).toBe('pass-locked-1');
    expect(receivedPayloads).toHaveLength(2);
    expect(receivedPayloads[0].visitor.firstName).toBe('OriginalFirst');
    expect(receivedPayloads[1].visitor.firstName).toBe('OriginalFirst'); // NOT TamperedFirst!

    // 3. UI contract verification: GetPassPage hides/disables Edit Details, Retake Selfie, and Retake ID when phase === 'ambiguous'
    const { readFileSync } = await import('node:fs');
    const getPassSrc = readFileSync('src/pages/GetPassPage.tsx', 'utf8');

    // Ambiguous banner is shown
    expect(getPassSrc).toContain("portalTransactionRef.current?.phase === 'ambiguous'");
    expect(getPassSrc).toContain('Generation result could not be confirmed');

    // Retake and Edit Details buttons are guarded behind phase !== 'ambiguous'
    expect(getPassSrc).toContain("portalTransactionRef.current?.phase !== 'ambiguous' && (");
    expect(getPassSrc).toContain('Retry Exact Submission');
    expect(getPassSrc).toContain('Start Over');
  });

  it('Portal C: Ambiguous submission -> Start Over establishes completely fresh transaction', async () => {
    const globalFetch = vi.fn(async (url: string) => {
      if (url.includes('/api/passes/issue')) {
        throw new TypeError('Failed to fetch');
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', globalFetch);

    const tx1 = await createPortalIssueTransaction();
    await expect(
      issueVisitorPass('portal', dummyVisitor, photoBlob, idBlob, tx1.requestId, undefined, tx1)
    ).rejects.toThrow('Generation result could not be confirmed');

    expect(tx1.phase).toBe('ambiguous');

    // Visitor chooses Start Over
    const tx2 = await createPortalIssueTransaction();
    expect(tx2.actorId).not.toBe(tx1.actorId);
    expect(tx2.requestId).not.toBe(tx1.requestId);
    expect(tx2.phase).toBe('editable');
    expect(tx2.photoIntentId).toBeNull();
    expect(tx2.idIntentId).toBeNull();
    expect(tx2.submittedPayload).toBeNull();
  });

  it('Portal D: visit_date_out_of_range authoritative rejection unfreezes payload, allows visitor to change date D1 to D2, and succeeds', async () => {
    let receivedPayloads: any[] = [];
    const globalFetch = vi.fn(async (url: string, init?: any) => {
      if (url.includes('/api/passes/issue')) {
        const body = JSON.parse(init?.body || '{}');
        receivedPayloads.push(body);
        if (body.visitor.visitDate === '2026-10-20') {
          return {
            status: 422,
            ok: false,
            json: async () => ({ error: 'visit_date_out_of_range' }),
          };
        }
        return {
          status: 201,
          ok: true,
          json: async () => ({ passId: 'pass-corrected-d2', qrToken: 'qr-d2' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', globalFetch);

    const transaction = await createPortalIssueTransaction();
    const visitorD1 = { ...dummyVisitor, visitDate: '2026-10-20' };

    // 1. Submit with out-of-range date D1
    await expect(
      issueVisitorPass('portal', visitorD1, photoBlob, idBlob, transaction.requestId, undefined, transaction)
    ).rejects.toThrow('Visit date is outside the allowed scheduling window.');

    // Invariant: Authoritative pre-commit rejection resets phase to editable and unfreezes payload
    expect(transaction.phase).toBe('editable');
    expect(transaction.submittedPayload).toBeNull();

    // 2. Visitor changes date to valid D2 and resubmits
    const visitorD2 = { ...dummyVisitor, visitDate: '2026-10-28' };
    const result = await issueVisitorPass(
      'portal',
      visitorD2,
      photoBlob,
      idBlob,
      transaction.requestId,
      undefined,
      transaction
    );

    expect(result.passId).toBe('pass-corrected-d2');
    expect(receivedPayloads).toHaveLength(2);
    expect(receivedPayloads[0].visitor.visitDate).toBe('2026-10-20');
    expect(receivedPayloads[1].visitor.visitDate).toBe('2026-10-28');
  });

  it('Portal E & F: Start Over with Photo A -> Photo B creates fresh upload intent B without leaking Photo Intent A or Payload 1', async () => {
    let receivedPayloads: any[] = [];
    const globalFetch = vi.fn(async (url: string, init?: any) => {
      if (url.includes('/api/passes/issue')) {
        const body = JSON.parse(init?.body || '{}');
        receivedPayloads.push(body);
        if (receivedPayloads.length === 1) {
          throw new TypeError('Network connection reset');
        }
        return {
          status: 201,
          ok: true,
          json: async () => ({ passId: 'pass-fresh-tx2', qrToken: 'qr-tx2' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', globalFetch);

    // Transaction 1 with Photo A
    const tx1 = await createPortalIssueTransaction();
    const photoBlobA = new Blob(['photo-A'], { type: 'image/webp' });
    const visitor1 = { ...dummyVisitor, purpose: 'Interview A' };

    await expect(
      issueVisitorPass('portal', visitor1, photoBlobA, idBlob, tx1.requestId, undefined, tx1)
    ).rejects.toThrow('Generation result could not be confirmed');

    expect(tx1.phase).toBe('ambiguous');
    const photoIntentA = tx1.photoIntentId;
    expect(photoIntentA).toBeTruthy();

    // Explicit Start Over: create fresh transaction 2 with Photo B and Visitor 2
    const tx2 = await createPortalIssueTransaction();
    expect(tx2.actorId).not.toBe(tx1.actorId);
    expect(tx2.requestId).not.toBe(tx1.requestId);
    expect(tx2.photoIntentId).toBeNull();
    expect(tx2.submittedPayload).toBeNull();

    const photoBlobB = new Blob(['photo-B'], { type: 'image/webp' });
    const visitor2 = { ...dummyVisitor, purpose: 'Official Visit B' };

    const result = await issueVisitorPass('portal', visitor2, photoBlobB, idBlob, tx2.requestId, undefined, tx2);

    expect(result.passId).toBe('pass-fresh-tx2');
    expect(tx2.photoIntentId).not.toBe(photoIntentA); // Fresh upload intent B!
    expect(receivedPayloads).toHaveLength(2);
    // Assert Portal F: No stale payload from transaction 1 leaks into transaction 2
    expect(receivedPayloads[0].visitor.purpose).toBe('Interview A');
    expect(receivedPayloads[1].visitor.purpose).toBe('Official Visit B');
    expect(receivedPayloads[0].photoIntentId).toBe(photoIntentA);
    expect(receivedPayloads[1].photoIntentId).toBe(tx2.photoIntentId);
    expect(receivedPayloads[1].photoIntentId).not.toBe(receivedPayloads[0].photoIntentId);
  });

  it('R2-A & Outcome Classification: Generic 503 service_unavailable is classified as ambiguous and locks transaction for exact replay', async () => {
    // Assert classification helper truthfulness
    expect(classifySubmissionOutcome(422, 'visit_date_out_of_range')).toBe('rejected_correctable_field');
    expect(classifySubmissionOutcome(429, 'rate_limit_exceeded')).toBe('rejected_correctable_field');
    expect(classifySubmissionOutcome(503, 'abuse_control_unavailable')).toBe('rejected_correctable_field');
    expect(classifySubmissionOutcome(503, 'service_unavailable')).toBe('ambiguous');
    expect(classifySubmissionOutcome(500, 'issue_failed')).toBe('ambiguous');
    expect(classifySubmissionOutcome(500, 'internal_error')).toBe('ambiguous');

    let receivedPayloads: any[] = [];
    const globalFetch = vi.fn(async (url: string, init?: any) => {
      if (url.includes('/api/passes/issue')) {
        const body = JSON.parse(init?.body || '{}');
        receivedPayloads.push(body);
        if (receivedPayloads.length === 1) {
          // Server returns HTTP 503 service_unavailable (ambiguous because issue_pass may have committed)
          return {
            status: 503,
            ok: false,
            json: async () => ({ error: 'service_unavailable' }),
          };
        }
        // Retry returns committed pass
        return {
          status: 200,
          ok: true,
          json: async () => ({ passId: 'pass-503-retry', qrToken: 'qr-503' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', globalFetch);

    const transaction = await createPortalIssueTransaction();
    const originalActor = transaction.actorId;
    const originalRequestId = transaction.requestId;
    const originalVisitor = { ...dummyVisitor, firstName: 'OriginalPayloadV' };

    // 1. First attempt fails with 503 service_unavailable
    await expect(
      issueVisitorPass('portal', originalVisitor, photoBlob, idBlob, transaction.requestId, undefined, transaction)
    ).rejects.toThrow('Generation result could not be confirmed. Please retry your submission.');

    // Invariant: phase is ambiguous, submittedPayload is preserved, intents are preserved
    expect(transaction.phase).toBe('ambiguous');
    expect(transaction.submittedPayload?.visitor.firstName).toBe('OriginalPayloadV');
    expect(transaction.actorId).toBe(originalActor);
    expect(transaction.requestId).toBe(originalRequestId);
    expect(transaction.photoIntentId).toBe('intent-photo-1');
    expect(transaction.idIntentId).toBe('intent-id-2');

    // 2. Retry with altered input: network request MUST still send original frozen payload V
    const alteredVisitor = { ...dummyVisitor, firstName: 'AlteredInputNotPermitted' };
    const result = await issueVisitorPass(
      'portal',
      alteredVisitor,
      photoBlob,
      idBlob,
      transaction.requestId,
      undefined,
      transaction
    );

    expect(result.passId).toBe('pass-503-retry');
    expect(receivedPayloads).toHaveLength(2);
    expect(receivedPayloads[0].visitor.firstName).toBe('OriginalPayloadV');
    expect(receivedPayloads[1].visitor.firstName).toBe('OriginalPayloadV'); // Must NOT be AlteredInputNotPermitted!
    expect(receivedPayloads[1].requestId).toBe(originalRequestId);
    expect(receivedPayloads[1].photoIntentId).toBe('intent-photo-1');
    expect(receivedPayloads[1].idIntentId).toBe('intent-id-2');
  });

  it('R2-B: abuse_control_unavailable is an authoritative pre-commit rejection and safely unfreezes transaction to editable', async () => {
    let receivedPayloads: any[] = [];
    const globalFetch = vi.fn(async (url: string, init?: any) => {
      if (url.includes('/api/passes/issue')) {
        const body = JSON.parse(init?.body || '{}');
        receivedPayloads.push(body);
        if (receivedPayloads.length === 1) {
          // Known pre-commit error: abuse control unavailable
          return {
            status: 503,
            ok: false,
            json: async () => ({ error: 'abuse_control_unavailable' }),
          };
        }
        return {
          status: 201,
          ok: true,
          json: async () => ({ passId: 'pass-abuse-recovered', qrToken: 'qr-abuse' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    vi.stubGlobal('fetch', globalFetch);

    const transaction = await createPortalIssueTransaction();
    const visitorAttempt1 = { ...dummyVisitor, firstName: 'FirstName1' };

    // 1. Initial attempt fails with abuse_control_unavailable
    await expect(
      issueVisitorPass('portal', visitorAttempt1, photoBlob, idBlob, transaction.requestId, undefined, transaction)
    ).rejects.toThrow('Pass service is temporarily unavailable.');

    // Invariant: Authoritative pre-commit rejection resets phase to editable and unfreezes payload
    expect(transaction.phase).toBe('editable');
    expect(transaction.submittedPayload).toBeNull();

    // 2. Visitor can correct/update information and submit fresh attempt
    const visitorAttempt2 = { ...dummyVisitor, firstName: 'FirstNameCorrected' };
    const result = await issueVisitorPass(
      'portal',
      visitorAttempt2,
      photoBlob,
      idBlob,
      transaction.requestId,
      undefined,
      transaction
    );

    expect(result.passId).toBe('pass-abuse-recovered');
    expect(receivedPayloads).toHaveLength(2);
    expect(receivedPayloads[0].visitor.firstName).toBe('FirstName1');
    expect(receivedPayloads[1].visitor.firstName).toBe('FirstNameCorrected');
  });
});
