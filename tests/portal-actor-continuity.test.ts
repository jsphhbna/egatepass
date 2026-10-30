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

const dummyActorId = '11111111-1111-4111-8111-111111111111';
const dummyToken = 'mock-portal-jwt-token-xyz';

const mockRpc = vi.fn().mockReturnValue({
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

const mockPortalClient: any = {
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
    signOut: vi.fn().mockResolvedValue({ error: null }),
    signInAnonymously: vi.fn().mockResolvedValue({
      data: {
        session: {
          access_token: dummyToken,
          user: {
            id: dummyActorId,
            is_anonymous: true,
          },
        },
      },
      error: null,
    }),
  },
  rpc: mockRpc,
  schema: vi.fn().mockReturnValue({
    rpc: mockRpc,
  }),
  storage: {
    from: vi.fn().mockReturnValue({
      uploadToSignedUrl: vi.fn().mockResolvedValue({ error: null }),
      upload: vi.fn().mockResolvedValue({ error: null }),
    }),
  },
};

vi.mock('@/lib/supabase', () => ({
  requirePortalSupabase: () => mockPortalClient,
  requireSupabase: () => mockPortalClient,
}));

describe('Portal Actor Continuity & Evidence Upload Pipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPortalClient.auth.getSession.mockResolvedValue({
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
    });
    mockRpc.mockReturnValue({
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
  });

  const createMockTransaction = (overrides?: Partial<PortalIssueTransaction>): PortalIssueTransaction => {
    return {
      requestId: 'test-req-id-1234',
      actorId: dummyActorId,
      token: dummyToken,
      photoIntentId: null,
      idIntentId: null,
      phase: 'editable',
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
    const tx = createMockTransaction();

    mockPortalClient.auth.getSession.mockResolvedValue({
      data: { session: null },
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
    const tx = createMockTransaction({ actorId: staffId });

    mockPortalClient.auth.getSession.mockResolvedValue({
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

  it('strictly rejects undefined or missing is_anonymous claim with portal_actor_not_anonymous error', async () => {
    const tx = createMockTransaction();

    mockPortalClient.auth.getSession.mockResolvedValue({
      data: {
        session: {
          access_token: 'portal-token-unspecified-anon',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
          user: { id: dummyActorId }, // is_anonymous undefined
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
    const tx = createMockTransaction({ actorId: dummyActorId });

    mockPortalClient.auth.getSession.mockResolvedValue({
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
    expect(mockPortalClient.schema).toHaveBeenCalledWith('api');
    expect(mockRpc).toHaveBeenCalledWith('create_upload_intent', {
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
    mockPortalClient.schema = vi.fn().mockReturnValue({ rpc: errRpc });

    const fakeBlob = new Blob(['test image data'], { type: 'image/jpeg' });
    await expect(uploadPortalEvidence(tx, 'photo', fakeBlob)).rejects.toThrow(/visitor identity required/);
  });

  it('preflightPortalLiveFace includes Bearer portal token in request headers', async () => {
    const tx = createMockTransaction();
    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
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
        requestId: 'test-req-id-1234',
        photoIntentId: 'photo-intent-5678',
        mode: 'preflight_face',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accurately classifies preflight error taxonomy: 401->Session, 422 quality->Quality, 422 upload->Upload, 429->RateLimit, 503->Service, timeout->Network', async () => {
    const tx = createMockTransaction();

    // 1. HTTP 401 converts to PortalSessionError, NOT photo quality
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: vi.fn().mockResolvedValue({ error: 'invalid_session' }),
    }));
    await expect(preflightPortalLiveFace(tx, 'p1')).rejects.toThrow(PortalSessionError);

    // 2. HTTP 422 with error = quality_rejected returns category = 'quality'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: vi.fn().mockResolvedValue({
        ok: false,
        error: 'quality_rejected',
        reasonCode: 'no_face_detected',
        message: 'No face detected in photo',
      }),
    }));
    const qualityRes = await preflightPortalLiveFace(tx, 'p2');
    expect(qualityRes.ok).toBe(false);
    expect(qualityRes.category).toBe('quality');
    expect(qualityRes.reasonCode).toBe('no_face_detected');

    // 3. HTTP 422 with error = invalid_upload_intent_photo returns category = 'upload', NOT quality
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: vi.fn().mockResolvedValue({
        error: 'invalid_upload_intent_photo',
      }),
    }));
    const uploadRes = await preflightPortalLiveFace(tx, 'p3');
    expect(uploadRes.ok).toBe(false);
    expect(uploadRes.category).toBe('upload');
    expect(uploadRes.category).not.toBe('quality');

    // 4. HTTP 429 returns category = 'rate_limit', NOT quality
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: vi.fn().mockResolvedValue({
        error: 'rate_limit_exceeded',
        message: 'Too many attempts',
      }),
    }));
    const rlRes = await preflightPortalLiveFace(tx, 'p4');
    expect(rlRes.ok).toBe(false);
    expect(rlRes.category).toBe('rate_limit');

    // 5. HTTP 503 abuse_control_unavailable returns category = 'service', NOT quality
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 503,
      json: vi.fn().mockResolvedValue({
        error: 'abuse_control_unavailable',
      }),
    }));
    const serviceRes = await preflightPortalLiveFace(tx, 'p5');
    expect(serviceRes.ok).toBe(false);
    expect(serviceRes.category).toBe('service');

    // 6. Network failure returns category = 'network'
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    const netRes = await preflightPortalLiveFace(tx, 'p6');
    expect(netRes.ok).toBe(false);
    expect(netRes.category).toBe('network');

    vi.unstubAllGlobals();
  });

  it('verifyPortalIdentity includes Bearer portal token in request headers', async () => {
    const tx = createMockTransaction();
    const globalFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: vi.fn().mockResolvedValue({
        outcome: 'matched',
        matched: true,
        score: 0.82,
        reason: null,
      }),
    });
    vi.stubGlobal('fetch', globalFetch);

    try {
      const response = await verifyPortalIdentity(tx, 'photo-intent-1111', 'id-intent-2222');
      expect(response.matched).toBe(true);

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
});
