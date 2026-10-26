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
                bucket_id: 'visitor-evidence',
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
});
