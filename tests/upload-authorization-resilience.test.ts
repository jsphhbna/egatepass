import { describe, it, expect, vi } from 'vitest';
import {
  uploadCheckpointedEvidence,
  createIssueTransaction,
  PortalSessionError,
  UploadAuthorizationError,
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
});
