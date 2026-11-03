import { describe, it, expect, vi } from 'vitest';
import {
  uploadCheckpointedEvidence,
  createIssueTransaction,
  abandonPortalEvidence,
  drainPendingAbandonments,
  invalidatePortalEvidenceCheckpoint,
  PortalSessionError,
  UploadAuthorizationError,
  UploadQuotaExceededError,
  StorageUploadError,
  PreflightQualityError,
} from '../src/services/visitorRegistration.js';

describe('Upload Authorization & Storage Resilience Contract', () => {
  it('1. Upload error types are correctly differentiated and instantiated', () => {
    const sessionErr = new PortalSessionError('portal_session_expired', 'Session expired');
    expect(sessionErr.name).toBe('PortalSessionError');
    expect(sessionErr.code).toBe('portal_session_expired');

    const authErr = new UploadAuthorizationError('upload_intent_unauthorized', 'Not authorized', 403);
    expect(authErr.name).toBe('UploadAuthorizationError');
    expect(authErr.code).toBe('upload_intent_unauthorized');
    expect(authErr.status).toBe(403);

    const quotaErr = new UploadQuotaExceededError('too_many_pending_intents', 'Quota exceeded');
    expect(quotaErr.name).toBe('UploadQuotaExceededError');
    expect(quotaErr.code).toBe('too_many_pending_intents');
    expect(quotaErr.status).toBe(429);

    const storageRetryable = new StorageUploadError('storage_timeout', 'Timeout 15s', 408, true);
    expect(storageRetryable.name).toBe('StorageUploadError');
    expect(storageRetryable.code).toBe('storage_timeout');
    expect(storageRetryable.retryable).toBe(true);

    const storageFatal = new StorageUploadError('file_size_exceeded', '5MB exceeded', 413, false);
    expect(storageFatal.retryable).toBe(false);

    const qualityErr = new PreflightQualityError('quality_rejected', 'Face off center', 'face_off_center');
    expect(qualityErr.name).toBe('PreflightQualityError');
    expect(qualityErr.reasonCode).toBe('face_off_center');
  });

  it('2. Successfully creates upload intent and uploads to storage on first attempt', async () => {
    const tx = createIssueTransaction('portal');
    const mockBlob = new Blob(['sample-image-data'], { type: 'image/jpeg' });

    const mockStorageUpload = vi.fn().mockResolvedValue({ data: { path: 'objects/p1.jpg' }, error: null });
    const mockRpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          intent_id: 'intent-uuid-1',
          bucket_id: 'visitor-evidence',
          object_path: 'portal/intent-uuid-1/photo.jpg',
          content_type: 'image/jpeg',
          max_bytes: 5242880,
          expires_at: new Date(Date.now() + 900000).toISOString(),
        },
        error: null,
      }),
    });

    const mockClient = {
      schema: vi.fn().mockReturnValue({ rpc: mockRpc }),
      storage: {
        from: vi.fn().mockReturnValue({ upload: mockStorageUpload }),
      },
    } as any;

    const res = await uploadCheckpointedEvidence(mockClient, 'portal', 'photo', mockBlob, tx);
    expect(res.intentId).toBe('intent-uuid-1');
    expect(res.checkpoint.uploaded).toBe(true);
    expect(tx.photoIntentId).toBe('intent-uuid-1');
    expect(tx.photoCheckpoint?.uploaded).toBe(true);
    expect(mockStorageUpload).toHaveBeenCalledTimes(1);
  });

  it('3. Safely handles storage 409 Conflict / duplicate as already uploaded (idempotency)', async () => {
    const tx = createIssueTransaction('portal');
    const mockBlob = new Blob(['sample-image-data'], { type: 'image/jpeg' });

    // Simulate Supabase Storage returning 409 Conflict because a previous retry already placed the file
    const mockStorageUpload = vi.fn().mockResolvedValue({
      data: null,
      error: { message: 'The resource already exists', statusCode: '409' },
    });

    const mockRpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          intent_id: 'intent-uuid-dup',
          bucket_id: 'visitor-evidence',
          object_path: 'portal/intent-uuid-dup/photo.jpg',
          content_type: 'image/jpeg',
          max_bytes: 5242880,
          expires_at: new Date(Date.now() + 900000).toISOString(),
        },
        error: null,
      }),
    });

    const mockClient = {
      schema: vi.fn().mockReturnValue({ rpc: mockRpc }),
      storage: {
        from: vi.fn().mockReturnValue({ upload: mockStorageUpload }),
      },
    } as any;

    const res = await uploadCheckpointedEvidence(mockClient, 'portal', 'photo', mockBlob, tx);
    expect(res.intentId).toBe('intent-uuid-dup');
    expect(res.checkpoint.uploaded).toBe(true);
  });

  it('4. Reclassifies session expiration in create_upload_intent as PortalSessionError', async () => {
    const tx = createIssueTransaction('portal');
    const mockBlob = new Blob(['sample-image-data'], { type: 'image/jpeg' });

    // Simulate expired session inside Postgres RPC (P0001: Anonymous session required)
    const mockRpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { code: 'P0001', message: 'Anonymous or authenticated session required' },
      }),
    });

    const mockClient = {
      schema: vi.fn().mockReturnValue({ rpc: mockRpc }),
      storage: { from: vi.fn() },
    } as any;

    await expect(
      uploadCheckpointedEvidence(mockClient, 'portal', 'photo', mockBlob, tx)
    ).rejects.toThrow(PortalSessionError);
  });

  it('5. Throws StorageUploadError when upload times out or fails network connection', async () => {
    const tx = createIssueTransaction('portal');
    const mockBlob = new Blob(['sample-image-data'], { type: 'image/jpeg' });

    const mockStorageUpload = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    const mockRpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: {
          intent_id: 'intent-uuid-net',
          bucket_id: 'visitor-evidence',
          object_path: 'portal/intent-uuid-net/photo.jpg',
          content_type: 'image/jpeg',
          max_bytes: 5242880,
          expires_at: new Date(Date.now() + 900000).toISOString(),
        },
        error: null,
      }),
    });

    const mockClient = {
      schema: vi.fn().mockReturnValue({ rpc: mockRpc }),
      storage: {
        from: vi.fn().mockReturnValue({ upload: mockStorageUpload }),
      },
    } as any;

    await expect(
      uploadCheckpointedEvidence(mockClient, 'portal', 'photo', mockBlob, tx)
    ).rejects.toThrow(StorageUploadError);
  });

  it('6. Reclassifies P0003 too_many_pending_intents as UploadQuotaExceededError (429)', async () => {
    const tx = createIssueTransaction('portal');
    const mockBlob = new Blob(['sample-image-data'], { type: 'image/jpeg' });

    // Simulate quota exceeded error from PostgreSQL create_upload_intent
    const mockRpc = vi.fn().mockReturnValue({
      abortSignal: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: null,
        error: {
          code: 'P0003',
          message: 'too_many_pending_intents: pending upload quota exceeded (maximum 10 active intents allowed per session)',
        },
      }),
    });

    const mockClient = {
      schema: vi.fn().mockReturnValue({ rpc: mockRpc }),
      storage: { from: vi.fn() },
    } as any;

    await expect(
      uploadCheckpointedEvidence(mockClient, 'portal', 'photo', mockBlob, tx)
    ).rejects.toThrow(UploadQuotaExceededError);
  });

  it('7. abandonPortalEvidence calls abandon-intent endpoint and clears in-memory transaction', async () => {
    const tx = createIssueTransaction('portal');
    tx.photoIntentId = 'intent-to-abandon-123';
    tx.photoCheckpoint = {
      intentId: 'intent-to-abandon-123',
      bucketId: 'visitor-evidence',
      objectPath: 'portal/intent-to-abandon-123/photo.jpg',
      contentType: 'image/webp',
      maxBytes: 5242880,
      uploaded: true,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, intentId: 'intent-to-abandon-123' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const mockClient = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-session-jwt' } } }),
      },
    } as any;

    const result = await abandonPortalEvidence(tx, 'photo', mockClient);

    expect(result.success).toBe(true);
    expect(result.status).toBe('abandoned');
    expect(result.intentId).toBe('intent-to-abandon-123');
    expect(result.databaseExpired).toBe(true);
    expect(result.storageCleaned).toBe(true);
    expect(tx.photoIntentId).toBeNull();
    expect(tx.photoCheckpoint).toBeNull();
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/passes/abandon-intent',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-session-jwt',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({ intentId: 'intent-to-abandon-123' }),
      })
    );

    fetchSpy.mockRestore();
  });

  it('8. Invalidation and retake properly isolates subsequent upload attempts', () => {
    const tx = createIssueTransaction('portal');
    tx.photoIntentId = 'old-intent-id';
    tx.photoCheckpoint = {
      intentId: 'old-intent-id',
      bucketId: 'visitor-evidence',
      objectPath: 'portal/old-intent-id/photo.jpg',
      contentType: 'image/webp',
      maxBytes: 5242880,
      uploaded: true,
    };

    invalidatePortalEvidenceCheckpoint(tx, 'photo');
    expect(tx.photoIntentId).toBeNull();
    expect(tx.photoCheckpoint).toBeNull();
  });

  it('9. queues pending abandonment on network failure and drains on next action', async () => {
    const tx = createIssueTransaction('portal');
    tx.photoIntentId = 'network-failed-intent';
    tx.photoCheckpoint = {
      intentId: 'network-failed-intent',
      bucketId: 'visitor-evidence',
      objectPath: 'portal/network-failed-intent/photo.jpg',
      contentType: 'image/webp',
      maxBytes: 5242880,
      uploaded: true,
    };

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network offline'));

    const mockClient = {
      auth: {
        getSession: vi.fn().mockResolvedValue({ data: { session: { access_token: 'test-session-jwt' } } }),
      },
    } as any;

    const res = await abandonPortalEvidence(tx, 'photo', mockClient);
    expect(res.success).toBe(false);
    expect(res.status).toBe('network_error');
    expect(tx.pendingAbandonments).toContain('network-failed-intent');
    expect(tx.photoIntentId).toBeNull(); // memory cleared immediately

    // Mock successful drain
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, code: 'abandoned' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await drainPendingAbandonments(tx, mockClient);
    expect(tx.pendingAbandonments).not.toContain('network-failed-intent');

    fetchSpy.mockRestore();
  });
});
