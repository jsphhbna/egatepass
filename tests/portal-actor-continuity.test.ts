import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createPortalIssueTransaction,
  validatePortalSession,
  getVerifiedPortalSession,
  uploadPortalEvidence,
  preflightPortalLiveFace,
  verifyPortalIdentity,
  PortalSessionError,
  type PortalIssueTransaction,
} from '../src/services/visitorRegistration';

describe('Portal Actor Continuity & Evidence Upload Pipeline', () => {
  const dummyActorId = '11111111-1111-4111-8111-111111111111';
  const dummyToken = 'mock-portal-jwt-token-xyz';

  const createMockTransaction = (overrides?: Partial<PortalIssueTransaction>): PortalIssueTransaction => {
    const rpcMock = vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: {
          intent_id: 'intent-uuid-1234',
          bucket_id: 'visitor-photos',
          object_path: `${dummyActorId}/intent-uuid-1234/photo.jpg`,
          expires_at: new Date(Date.now() + 900000).toISOString(),
          max_bytes: 5242880,
        },
        error: null,
      }),
    });

    const mockClient: any = {
      auth: {
        getSession: vi.fn().mockResolvedValue({
          data: {
            session: {
              access_token: dummyToken,
              expires_at: Math.floor(Date.now() / 1000) + 3600,
              user: {
                id: dummyActorId,
                is_anonymous: true,
              },
            },
          },
          error: null,
        }),
      },
      rpc: rpcMock,
      schema: vi.fn().mockReturnValue({
        rpc: rpcMock,
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          uploadToSignedUrl: vi.fn().mockResolvedValue({ error: null }),
          upload: vi.fn().mockResolvedValue({ error: null }),
        }),
      },
    };

    return {
      client: mockClient,
      actorId: dummyActorId,
      session: {
        access_token: dummyToken,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: {
          id: dummyActorId,
          is_anonymous: true,
        },
      } as any,
      createdPassId: null,
      ...overrides,
    };
  };

  it('validates active anonymous portal session successfully', async () => {
    const tx = createMockTransaction();
    const isValid = await validatePortalSession(tx);
    expect(isValid).toBe(true);

    const verifiedSession = await getVerifiedPortalSession(tx);
    expect(verifiedSession.token).toBe(dummyToken);
    expect(verifiedSession.session.user.id).toBe(dummyActorId);
    expect(verifiedSession.session.user.is_anonymous).toBe(true);
  });

  it('rejects expired portal session with portal_session_missing error', async () => {
    const tx = createMockTransaction({
      session: {
        access_token: dummyToken,
        expires_at: Math.floor(Date.now() / 1000) - 60, // expired 60s ago
        user: {
          id: dummyActorId,
          is_anonymous: true,
        },
      } as any,
    });

    tx.client.auth.getSession = vi.fn().mockResolvedValue({
      data: {
        session: null,
      },
      error: null,
    });

    const isValid = await validatePortalSession(tx);
    expect(isValid).toBe(false);

    await expect(getVerifiedPortalSession(tx)).rejects.toThrow(PortalSessionError);
    await expect(getVerifiedPortalSession(tx)).rejects.toMatchObject({
      code: 'portal_session_missing',
    });
  });

  it('rejects authenticated non-anonymous user session with portal_actor_not_anonymous error', async () => {
    const staffId = 'staff-admin-uuid-9999';
    const tx = createMockTransaction({
      actorId: staffId,
      session: {
        access_token: 'staff-jwt-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: {
          id: staffId,
          is_anonymous: false, // Operator / staff account!
        },
      } as any,
    });

    tx.client.auth.getSession = vi.fn().mockResolvedValue({
      data: {
        session: {
          access_token: 'staff-jwt-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: staffId, is_anonymous: false },
        },
      },
      error: null,
    });

    const isValid = await validatePortalSession(tx);
    expect(isValid).toBe(false);

    await expect(getVerifiedPortalSession(tx)).rejects.toThrow(PortalSessionError);
    await expect(getVerifiedPortalSession(tx)).rejects.toMatchObject({
      code: 'portal_actor_not_anonymous',
    });
  });

  it('rejects session actor mismatch with portal_session_mismatch error', async () => {
    const otherVisitorId = '22222222-2222-4222-8222-222222222222';
    const tx = createMockTransaction({
      actorId: dummyActorId, // Expects dummyActorId
      session: {
        access_token: 'different-visitor-token',
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: {
          id: otherVisitorId, // Different anonymous user!
          is_anonymous: true,
        },
      } as any,
    });

    tx.client.auth.getSession = vi.fn().mockResolvedValue({
      data: {
        session: {
          access_token: 'different-visitor-token',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: otherVisitorId, is_anonymous: true },
        },
      },
      error: null,
    });

    const isValid = await validatePortalSession(tx);
    expect(isValid).toBe(false);

    await expect(getVerifiedPortalSession(tx)).rejects.toThrow(PortalSessionError);
    await expect(getVerifiedPortalSession(tx)).rejects.toMatchObject({
      code: 'portal_session_mismatch',
    });
  });

  it('uploadPortalEvidence calls create_upload_intent with portal source and uploads with portal client', async () => {
    const tx = createMockTransaction();
    const fakeBlob = new Blob(['test image data'], { type: 'image/jpeg' });

    const result = await uploadPortalEvidence(tx, 'photo', fakeBlob);

    // Verify RPC was called with requested_source: 'portal'
    expect(tx.client.schema).toHaveBeenCalledWith('api');
    const rpcFn = tx.client.schema().rpc;
    expect(rpcFn).toHaveBeenCalledWith('create_upload_intent', {
      requested_source: 'portal',
      requested_kind: 'photo',
      requested_content_type: 'image/jpeg',
    });

    expect(result.intentId).toBe('intent-uuid-1234');
    expect(result.checkpoint.bucketId).toBe('visitor-photos');
    expect(result.checkpoint.objectPath).toBe(`${dummyActorId}/intent-uuid-1234/photo.jpg`);
  });

  it('uploadPortalEvidence maps 403 RPC error distinctly and does not mask as quality check failure', async () => {
    const tx = createMockTransaction();
    const errRpc = vi.fn().mockReturnValue({
      single: vi.fn().mockResolvedValue({
        data: null,
        error: { code: '42501', message: 'visitor identity required' },
      }),
    });
    tx.client.schema = vi.fn().mockReturnValue({ rpc: errRpc });

    const fakeBlob = new Blob(['test image data'], { type: 'image/jpeg' });
    await expect(uploadPortalEvidence(tx, 'photo', fakeBlob)).rejects.toThrow(/visitor identity required/);
  });

  it('preflightPortalLiveFace includes Bearer portal token in request headers', async () => {
    const tx = createMockTransaction();
    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        ok: true,
        message: 'Face quality check passed',
      }),
    });
    vi.stubGlobal('fetch', globalFetch);

    try {
      const response = await preflightPortalLiveFace(tx, 'photo-intent-5678');
      expect(response.ok).toBe(true);

      expect(globalFetch).toHaveBeenCalledTimes(1);
      const [url, options] = globalFetch.mock.calls[0];
      expect(url).toBe('/api/passes/verify-identity');
      expect(options.method).toBe('POST');
      expect(options.headers['Authorization']).toBe(`Bearer ${dummyToken}`);
      expect(JSON.parse(options.body)).toEqual({
        photoIntentId: 'photo-intent-5678',
        mode: 'preflight_face',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('verifyPortalIdentity includes Bearer portal token in request headers', async () => {
    const tx = createMockTransaction();
    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        result: 'matched',
        score: 0.82,
        reason: null,
      }),
    });
    vi.stubGlobal('fetch', globalFetch);

    try {
      const response = await verifyPortalIdentity(tx, 'photo-intent-1111', 'id-intent-2222');
      expect(response.result).toBe('matched');

      expect(globalFetch).toHaveBeenCalledTimes(1);
      const [url, options] = globalFetch.mock.calls[0];
      expect(url).toBe('/api/passes/verify-identity');
      expect(options.headers['Authorization']).toBe(`Bearer ${dummyToken}`);
      expect(JSON.parse(options.body)).toMatchObject({
        photoIntentId: 'photo-intent-1111',
        idIntentId: 'id-intent-2222',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('distinguishes live face error taxonomy: quality vs session vs upload vs network', () => {
    type ErrorCategory = 'quality' | 'session' | 'upload' | 'network' | 'service';

    const categorizeError = (err: any): { category: ErrorCategory; message: string } => {
      if (err instanceof PortalSessionError || err?.code?.startsWith('portal_session') || err?.message?.includes('session')) {
        return { category: 'session', message: 'Registration Session Error' };
      }
      if (err?.code === '42501' || err?.status === 403 || err?.message?.includes('upload') || err?.message?.includes('storage')) {
        return { category: 'upload', message: 'Photo Upload Error' };
      }
      if (err?.name === 'TypeError' && err?.message?.includes('fetch') || err?.message?.includes('Failed to fetch') || err?.message?.includes('NetworkError')) {
        return { category: 'network', message: 'Connection Problem' };
      }
      if (err?.type === 'blur' || err?.type === 'no_face' || err?.message?.includes('blurry') || err?.message?.includes('quality')) {
        return { category: 'quality', message: 'Photo Quality Check Failed' };
      }
      return { category: 'service', message: 'Identity Service Error' };
    };

    // 1. Quality check failure
    const qualityErr = categorizeError({ type: 'blur', message: 'Image is too blurry' });
    expect(qualityErr.category).toBe('quality');
    expect(qualityErr.message).toBe('Photo Quality Check Failed');

    // 2. Storage / 403 error must be 'upload', NOT quality check failure!
    const uploadErr = categorizeError({ code: '42501', message: 'Failed to upload photo intent' });
    expect(uploadErr.category).toBe('upload');
    expect(uploadErr.message).toBe('Photo Upload Error');
    expect(uploadErr.message).not.toBe('Photo Quality Check Failed');

    // 3. Expired or invalid session
    const sessionErr = categorizeError(new PortalSessionError('portal_session_missing', 'Session has expired'));
    expect(sessionErr.category).toBe('session');
    expect(sessionErr.message).toBe('Registration Session Error');

    // 4. Network error
    const netErr = categorizeError(new TypeError('Failed to fetch'));
    expect(netErr.category).toBe('network');
    expect(netErr.message).toBe('Connection Problem');
  });
});
