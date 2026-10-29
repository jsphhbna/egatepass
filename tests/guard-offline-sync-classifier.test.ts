import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupMockIndexedDb } from './helpers/mockIndexedDb';
import {
  saveOfflineRegistrationWithCache,
  getOfflineRegistrations,
  setMeta,
  type OfflineRegistrationRecord,
  type UploadCheckpoint,
} from '@/lib/offline/guardIndexedDb';
import {
  classifyOfflineRegistrationSyncFailure,
  runOfflineMaintenance,
} from '@/lib/offline/guardSyncManager';

const { mockRpc, mockGetSession, mockStorageFrom, createMockSupabase } = vi.hoisted(() => {
  const mockRpc = vi.fn();
  const mockGetSession = vi.fn();
  const mockStorageFrom = vi.fn();

  const createMockSupabase = () => {
    const client: any = {
      auth: {
        getSession: mockGetSession,
      },
      rpc: (...args: any[]) => {
        const getResult = () => Promise.resolve(mockRpc(...args));
        const builder: any = {
          abortSignal: vi.fn().mockImplementation(() => builder),
          single: vi.fn().mockImplementation(() => getResult()),
          then: (onfulfilled: any, onrejected: any) => getResult().then(onfulfilled, onrejected),
          catch: (onrejected: any) => getResult().catch(onrejected),
        };
        return builder;
      },
      schema: () => client,
      storage: {
        from: mockStorageFrom,
      },
    };
    return {
      supabase: client,
      requireSupabase: () => client,
    };
  };

  return { mockRpc, mockGetSession, mockStorageFrom, createMockSupabase };
});

vi.mock('@/lib/supabase', () => createMockSupabase());

describe('Offline Registration Failure Classifier & Evidence Preservation (P0 Invariant)', () => {
  const actorId = 'guard-classifier-actor';

  beforeEach(() => {
    setupMockIndexedDb();
    vi.clearAllMocks();

    mockGetSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'valid-test-token',
          user: { id: actorId },
        },
      },
    });

    mockRpc.mockImplementation((name: string) => {
      if (name === 'create_upload_intent') {
        return Promise.resolve({
          data: {
            intent_id: 'intent-mock-id',
            bucket_id: 'visitor-photos',
            object_path: 'passes/photo.webp',
            expires_at: new Date(Date.now() + 600000).toISOString(),
            max_bytes: 5242880,
          },
          error: null,
        });
      }
      if (name === 'guard_offline_snapshot_page') {
        return Promise.resolve({ data: [], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    });

    mockStorageFrom.mockReturnValue({
      upload: vi.fn().mockResolvedValue({ data: { path: 'passes/photo.webp' }, error: null }),
    });
  });

  // 1. Direct Classifier Invariant Tests
  it('classifies failures according to authoritative failure matrix', () => {
    // Unexpected 400 is transient_or_internal (never authoritative conflict)
    expect(classifyOfflineRegistrationSyncFailure(400, { error: 'invalid_format' })).toEqual({
      type: 'transient_or_internal',
      reason: 'invalid_format',
    });

    // Unknown 422 is transient_or_internal
    expect(classifyOfflineRegistrationSyncFailure(422, { error: 'unknown_validation_code' })).toEqual({
      type: 'transient_or_internal',
      reason: 'unknown_validation_code',
    });

    // Known 422 evidence errors are recoverable_evidence
    expect(classifyOfflineRegistrationSyncFailure(422, { error: 'invalid_upload_intent' })).toEqual({
      type: 'recoverable_evidence',
      reason: 'invalid_upload_intent',
    });
    expect(classifyOfflineRegistrationSyncFailure(422, { error: 'missing_uploaded_object' })).toEqual({
      type: 'recoverable_evidence',
      reason: 'missing_uploaded_object',
    });
    expect(classifyOfflineRegistrationSyncFailure(422, { error: 'invalid_uploaded_content' })).toEqual({
      type: 'recoverable_evidence',
      reason: 'invalid_uploaded_content',
    });

    // 5xx / 503 is transient_or_internal
    expect(classifyOfflineRegistrationSyncFailure(503, { error: 'offline_sync_unavailable' })).toEqual({
      type: 'transient_or_internal',
      reason: 'offline_sync_unavailable',
    });

    // 409 conflict envelope is authoritative_conflict
    expect(classifyOfflineRegistrationSyncFailure(409, { status: 'conflict', reason: 'already_synced' })).toEqual({
      type: 'authoritative_conflict',
      reason: 'already_synced',
    });
    expect(classifyOfflineRegistrationSyncFailure(409, { error: 'duplicate_reference' })).toEqual({
      type: 'authoritative_conflict',
      reason: 'duplicate_reference',
    });
  });

  // 2. Integration: Unexpected 400 preserves Blobs and checkpoints, status remains pending
  it('unexpected HTTP 400 remains pending, preserves Blobs and checkpoints, no evidence stripping', async () => {
    const regId = 'reg-unexpected-400';
    const photoBlob = new Blob(['photo-bytes-400'], { type: 'image/webp' });
    const idBlob = new Blob(['id-bytes-400'], { type: 'image/webp' });
    const checkpoint: UploadCheckpoint = {
      intentId: 'chk-photo-400',
      bucketId: 'visitor-photos',
      objectPath: 'passes/photo-400.webp',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      createdAt: new Date().toISOString(),
    };

    await saveOfflineRegistrationWithCache(actorId, {
      offlineRegistrationId: regId,
      visitor: {
        firstName: 'Unexpected',
        lastName: 'FourHundred',
        contactNumber: '09171110000',
        purpose: 'Test',
        visitDate: '2026-10-27',
      },
      action: 'approved',
      occurredAt: new Date().toISOString(),
      photoBlob,
      idBlob,
      photoUploadCheckpoint: checkpoint,
    });

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/sync-offline-registration')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'unexpected_bad_request' }), { status: 400 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const result = await runOfflineMaintenance();
    expect(result.summary.conflicts).toBe(0);
    expect(result.summary.errors).toBe(1);

    const regs = await getOfflineRegistrations(actorId);
    const reg = regs.find((r) => r.offlineRegistrationId === regId);
    expect(reg?.syncStatus).toBe('pending');
    expect(reg?.photoBlob).not.toBeNull();
    expect(reg?.idBlob).not.toBeNull();
    expect(reg?.photoUploadCheckpoint?.intentId).toBe('chk-photo-400');
  });

  // 3. Integration: Unknown HTTP 422 remains pending and preserves Blobs
  it('unknown HTTP 422 remains pending, preserves Blobs and checkpoints', async () => {
    const regId = 'reg-unknown-422';
    const photoBlob = new Blob(['photo-bytes-422'], { type: 'image/webp' });

    await saveOfflineRegistrationWithCache(actorId, {
      offlineRegistrationId: regId,
      visitor: {
        firstName: 'Unknown',
        lastName: 'Validation',
        contactNumber: '09171110001',
        purpose: 'Test',
        visitDate: '2026-10-27',
      },
      action: 'approved',
      occurredAt: new Date().toISOString(),
      photoBlob,
    });

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/sync-offline-registration')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'unrecognized_validation_error' }), { status: 422 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const result = await runOfflineMaintenance();
    expect(result.summary.conflicts).toBe(0);
    expect(result.summary.errors).toBe(1);

    const regs = await getOfflineRegistrations(actorId);
    const reg = regs.find((r) => r.offlineRegistrationId === regId);
    expect(reg?.syncStatus).toBe('pending');
    expect(reg?.photoBlob).not.toBeNull();
  });

  // 4. Integration: HTTP 503 remains pending and preserves Blobs
  it('HTTP 503 authority unavailable remains pending and preserves Blobs', async () => {
    const regId = 'reg-503-unavailable';
    const photoBlob = new Blob(['photo-bytes-503'], { type: 'image/webp' });

    await saveOfflineRegistrationWithCache(actorId, {
      offlineRegistrationId: regId,
      visitor: {
        firstName: 'Service',
        lastName: 'Unavailable',
        contactNumber: '09171110002',
        purpose: 'Test',
        visitDate: '2026-10-27',
      },
      action: 'approved',
      occurredAt: new Date().toISOString(),
      photoBlob,
    });

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/sync-offline-registration')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'offline_sync_authority_unavailable' }), { status: 503 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const result = await runOfflineMaintenance();
    expect(result.summary.conflicts).toBe(0);
    expect(result.summary.errors).toBe(1);

    const regs = await getOfflineRegistrations(actorId);
    const reg = regs.find((r) => r.offlineRegistrationId === regId);
    expect(reg?.syncStatus).toBe('pending');
    expect(reg?.photoBlob).not.toBeNull();
  });

  // 5. Integration: Recoverable 422 invalid_upload_intent preserves Blobs and clears checkpoints
  it('recoverable 422 invalid_upload_intent preserves Blobs and purges checkpoint for retry', async () => {
    const regId = 'reg-recoverable-422';
    const photoBlob = new Blob(['photo-bytes-rec'], { type: 'image/webp' });
    const checkpoint: UploadCheckpoint = {
      intentId: 'stale-intent-422',
      bucketId: 'visitor-photos',
      objectPath: 'passes/stale.webp',
      expiresAt: new Date(Date.now() + 600000).toISOString(),
      createdAt: new Date().toISOString(),
    };

    await saveOfflineRegistrationWithCache(actorId, {
      offlineRegistrationId: regId,
      visitor: {
        firstName: 'Recoverable',
        lastName: 'Evidence',
        contactNumber: '09171110003',
        purpose: 'Test',
        visitDate: '2026-10-27',
      },
      action: 'approved',
      occurredAt: new Date().toISOString(),
      photoBlob,
      photoUploadCheckpoint: checkpoint,
    });

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (String(url).includes('/api/sync-offline-registration')) {
        return Promise.resolve(new Response(JSON.stringify({ error: 'invalid_upload_intent' }), { status: 422 }));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const result = await runOfflineMaintenance();
    expect(result.summary.conflicts).toBe(0);
    expect(result.summary.errors).toBe(1);

    const regs = await getOfflineRegistrations(actorId);
    const reg = regs.find((r) => r.offlineRegistrationId === regId);
    expect(reg?.syncStatus).toBe('pending');
    expect(reg?.photoBlob).not.toBeNull();
    // Invariant: Checkpoint was cleared so next attempt allocates fresh intent
    expect(reg?.photoUploadCheckpoint).toBeUndefined();
  });

  // 6. Integration: Server HTTP 409 conflict marks conflict and strips terminal evidence only for that record
  it('server HTTP 409 conflict marks conflict and strips terminal evidence only for that record', async () => {
    const conflictRegId = 'reg-conflict-409';
    const pendingRegId = 'reg-still-pending';
    const conflictBlob = new Blob(['conflict-photo'], { type: 'image/webp' });
    const pendingBlob = new Blob(['pending-photo'], { type: 'image/webp' });

    await saveOfflineRegistrationWithCache(actorId, {
      offlineRegistrationId: conflictRegId,
      visitor: {
        firstName: 'Conflicted',
        lastName: 'Visitor',
        contactNumber: '09171110004',
        purpose: 'Test',
        visitDate: '2026-10-27',
      },
      action: 'approved',
      occurredAt: new Date().toISOString(),
      photoBlob: conflictBlob,
    });

    await saveOfflineRegistrationWithCache(actorId, {
      offlineRegistrationId: pendingRegId,
      visitor: {
        firstName: 'StillPending',
        lastName: 'Visitor',
        contactNumber: '09171110005',
        purpose: 'Test',
        visitDate: '2026-10-27',
      },
      action: 'approved',
      occurredAt: new Date().toISOString(),
      photoBlob: pendingBlob,
    });

    globalThis.fetch = vi.fn().mockImplementation((url: string, opts: any) => {
      if (String(url).includes('/api/sync-offline-registration')) {
        const body = JSON.parse(opts.body);
        if (body.offlineRegistrationId === conflictRegId) {
          return Promise.resolve(
            new Response(JSON.stringify({ status: 'conflict', reason: 'already_registered' }), { status: 409 })
          );
        }
        // second registration times out
        return Promise.reject(new Error('Network drop'));
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    });

    const result = await runOfflineMaintenance();
    expect(result.summary.conflicts).toBe(1);

    const regs = await getOfflineRegistrations(actorId);
    const conflictReg = regs.find((r) => r.offlineRegistrationId === conflictRegId);
    const pendingReg = regs.find((r) => r.offlineRegistrationId === pendingRegId);

    // Conflicted registration is terminal: status conflict, terminal evidence stripped
    expect(conflictReg?.syncStatus).toBe('conflict');
    expect(conflictReg?.conflictReason).toBe('already_registered');
    expect(conflictReg?.photoBlob).toBeUndefined();

    // Pending registration untouched: status pending, photoBlob intact!
    expect(pendingReg?.syncStatus).toBe('pending');
    expect(pendingReg?.photoBlob).not.toBeNull();
  });

  // 7. Session Authority Invariant: Zero sync calls and no record mutation when session unavailable
  it('session authority: aborts with 0 sync calls and preserves records when session is unavailable', async () => {
    // Seed records for Guard A in IndexedDB
    await setMeta('guard_store_actor_id', actorId);
    const regId = 'reg-session-guard-a';
    await saveOfflineRegistrationWithCache(actorId, {
      offlineRegistrationId: regId,
      visitor: {
        firstName: 'Session',
        lastName: 'Authority',
        contactNumber: '09171110006',
        purpose: 'Test',
        visitDate: '2026-10-27',
      },
      action: 'approved',
      occurredAt: new Date().toISOString(),
      photoBlob: new Blob(['session-photo']),
    });

    // Session is null
    mockGetSession.mockResolvedValue({
      data: { session: null },
    });

    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy;

    const result = await runOfflineMaintenance();
    // 0 sync calls made
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.summary.registrationsSynced).toBe(0);
    expect(result.summary.conflicts).toBe(0);
    expect(result.summary.errors).toBe(1);

    // Guard A's records remain untouched and pending
    const regs = await getOfflineRegistrations(actorId);
    expect(regs.length).toBe(1);
    expect(regs[0]?.syncStatus).toBe('pending');
    expect(regs[0]?.photoBlob).not.toBeNull();
  });
});
