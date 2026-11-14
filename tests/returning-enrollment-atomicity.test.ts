import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import passIssueHandler from '../server/routes/passes/issue.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';
import * as faceEngineModule from '../server/lib/face-engine.js';
import { computeMatchTokenDigest } from '../server/routes/passes/identify-returning.js';

describe('Returning Visitor & Ephemeral Verification Pass Issuance Invariants', () => {
  const originalEnv = process.env;
  const mockActorId = '11111111-1111-4111-8111-111111111111';
  const mockRequestId = '22222222-2222-4222-8222-222222222222';
  const mockPassId = '33333333-3333-4333-8333-333333333333';
  const mockVisitorId = '44444444-4444-4444-8444-444444444444';
  const mockPhotoIntentId = '55555555-5555-4555-8555-555555555555';
  const mockIdIntentId = '66666666-6666-4666-8666-666666666666';
  const mockProfileId = '77777777-7777-4777-8777-777777777777';
  const mockMatchToken = 'test-valid-match-token-abc123';

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PASS_TOKEN_SECRET: 'test-pass-token-secret-must-be-at-least-32-chars!',
      RETURNING_MATCH_TOKEN_SECRET: 'test-match-token-secret-must-be-at-least-32-chars!',
      RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-must-be-at-least-32-chars!',
    };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  function setupMocks(overrides: {
    issueRpcData?: any;
    issueRpcErr?: any;
  } = {}) {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: mockActorId } as any,
      isAnonymous: true,
      isRecoverySession: false,
    });

    function createQueryBuilder(table: string) {
      const q: any = {
        _table: table,
        _filters: {} as Record<string, any>,
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockImplementation((col: string, val: any) => {
          q._filters[col] = val;
          return q;
        }),
        is: vi.fn().mockImplementation((col: string, val: any) => {
          q._filters[col] = val;
          return q;
        }),
        in: vi.fn().mockImplementation((col: string, val: any) => {
          if (table === 'psgc_locations') {
            return Promise.resolve({
              data: [
                { psgc_code: '1300000000', name: 'National Capital Region (NCR)', level: 'region' },
                { psgc_code: '1380600000', name: 'City of Manila', level: 'city' },
                { psgc_code: '1380606014', name: 'Barangay 408', level: 'barangay' },
              ],
              error: null,
            });
          }
          return q;
        }),
        gt: vi.fn().mockReturnThis(),
        order: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        single: vi.fn().mockImplementation(() => {
          if (table === 'app_settings') {
            return Promise.resolve({
              data: {
                timezone: 'Asia/Manila',
                scheduling_days_ahead: 14,
                working_hours_start: '08:00',
                working_hours_end: '17:00',
                kiosk_mode_enabled: true,
                image_retention_days: 90,
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }),
        maybeSingle: vi.fn().mockImplementation(() => {
          if (table === 'passes') {
            if (q._filters.issue_request_id && !q._filters.id) {
              return Promise.resolve({ data: null, error: null }); // No replay pass
            }
          }
          if (table === 'upload_intents') {
            const isId = q._filters.id === mockIdIntentId;
            const isVeh = q._filters.id === '99999999-9999-4999-8999-999999999999';
            const kind = isVeh ? 'vehicle_photo' : (isId ? 'id' : 'photo');
            const bucket = isVeh ? 'visitor-vehicle-photos' : (isId ? 'visitor-ids' : 'visitor-photos');
            return Promise.resolve({
              data: {
                id: q._filters.id || mockPhotoIntentId,
                owner_id: mockActorId,
                source: 'portal',
                kind,
                bucket_id: bucket,
                object_path: `portal/${mockActorId}/${kind}.jpg`,
                content_type: 'image/jpeg',
                max_bytes: 5242880,
                status: 'pending',
                expires_at: new Date(Date.now() + 600000).toISOString(),
              },
              error: null,
            });
          }
          if (table === 'portal_identity_verification_attempts') {
            return Promise.resolve({
              data: {
                owner_id: mockActorId,
                request_id: mockRequestId,
                photo_intent_id: mockPhotoIntentId,
                id_intent_id: mockIdIntentId,
                outcome: 'matched',
                expires_at: new Date(Date.now() + 600000).toISOString(),
              },
              error: null,
            });
          }
          if (table === 'returning_identity_attempts') {
            return Promise.resolve({
              data: {
                id: 'attempt-123',
                matched_profile_id: mockProfileId,
                outcome: 'matched',
                expires_at: new Date(Date.now() + 600000).toISOString(),
              },
              error: null,
            });
          }
          if (table === 'returning_visitor_profiles') {
            return Promise.resolve({
              data: {
                id: mockProfileId,
                revoked_at: null,
              },
              error: null,
            });
          }
          return Promise.resolve({ data: null, error: null });
        }),
        update: vi.fn().mockImplementation((updates: any) => ({
          eq: vi.fn().mockReturnValue({
            select: vi.fn().mockResolvedValue({
              data: [{ id: mockProfileId }],
              error: null,
            }),
          }),
        })),
        insert: vi.fn().mockResolvedValue({ data: [{ id: 'veh-1' }], error: null }),
      };
      return q;
    }

    const rpcMock = vi.fn().mockImplementation((fn: string, params: any) => {
      if (fn === 'consume_rate_limit') {
        return Promise.resolve({ data: true, error: null });
      }
      if (fn === 'issue_online_pass_v6') {
        return {
          single: vi.fn().mockResolvedValue({
            data: overrides.issueRpcData !== undefined ? overrides.issueRpcData : {
              pass_id: mockPassId,
              public_reference: '77777777-7777-4777-8777-777777777777',
              valid_from: new Date().toISOString(),
              valid_until: new Date(Date.now() + 86400000).toISOString(),
            },
            error: overrides.issueRpcErr || null,
          }),
        };
      }
      return { single: vi.fn().mockResolvedValue({ data: null, error: null }) };
    });

    const mockAdmin: any = {
      from: vi.fn().mockImplementation((table: string) => createQueryBuilder(table)),
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockImplementation(() => {
            const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00]);
            return Promise.resolve({
              data: {
                arrayBuffer: () => Promise.resolve(fakeJpeg.buffer),
              },
              error: null,
            });
          }),
        }),
      },
      schema: vi.fn().mockReturnValue({
        rpc: rpcMock,
      }),
      rpcMock,
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      anon: {} as any,
    });

    return mockAdmin;
  }

  function makeNewVisitorRequest(opts: { omitPhoto?: boolean } = {}) {
    return new Request('http://localhost/api/passes/issue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid.visitor.jwt',
      },
      body: JSON.stringify({
        requestId: mockRequestId,
        source: 'portal',
        registrationMode: 'new',
        visitor: {
          firstName: 'Juan',
          lastName: 'Dela Cruz',
          contactNumber: '+639171234567',
          purpose: 'Official Campus Visit',
          visitDate: new Date().toISOString().slice(0, 10),
          homeAddress: 'Sampaloc, Manila',
        },
        arrivalMode: 'no_vehicle',
        psgc: {
          version: '2026-q3',
          regionCode: '1300000000',
          provinceCode: null,
          cityCode: '1380600000',
          barangayCode: '1380606014',
        },
        photoIntentId: opts.omitPhoto ? undefined : mockPhotoIntentId,
        idIntentId: mockIdIntentId,
      }),
    });
  }

  function makeReturningVisitorRequest(opts: { saveUpdates?: boolean; saveVehicle?: boolean } = {}) {
    return new Request('http://localhost/api/passes/issue', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer valid.visitor.jwt',
      },
      body: JSON.stringify({
        requestId: mockRequestId,
        source: 'portal',
        registrationMode: 'returning',
        visitor: {
          firstName: 'Juan',
          lastName: 'Dela Cruz',
          contactNumber: '+639171234567',
          purpose: 'Official Campus Visit',
          visitDate: new Date().toISOString().slice(0, 10),
          homeAddress: 'Sampaloc, Manila',
        },
        arrivalMode: opts.saveVehicle ? 'vehicle' : 'no_vehicle',
        vehicle: opts.saveVehicle ? {
          vehicleType: 'motorcycle',
          plateNumber: 'ABC 1234',
          color: 'Black',
          makeModel: 'Honda Click 125i',
          catalogStatus: 'manual',
          photoIntentId: '99999999-9999-4999-8999-999999999999',
          saveVehicle: true,
        } : undefined,
        psgc: {
          version: '2026-q3',
          regionCode: '1300000000',
          provinceCode: null,
          cityCode: '1380600000',
          barangayCode: '1380606014',
        },
        returning: {
          profileId: mockProfileId,
          matchToken: mockMatchToken,
          saveUpdates: Boolean(opts.saveUpdates),
        },
        // In returning mode, photoIntentId and idIntentId are intentionally omitted (ephemeral verification)
      }),
    });
  }

  it('1. Successfully issues new visitor pass and links profile in atomic issue_online_pass_v6 transaction', async () => {
    const admin = setupMocks();
    const res = await passIssueHandler.fetch(makeNewVisitorRequest());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.publicReference).toBe('77777777-7777-4777-8777-777777777777');
    expect(body.returningEnrollment).toBe('enrolled');

    // Verifies issue_online_pass_v6 was called with registrationMode = 'new' and photo/id intents
    expect(admin.rpcMock).toHaveBeenCalledWith('issue_online_pass_v6', expect.objectContaining({
      requested_registration_mode: 'new',
      requested_photo_intent_id: mockPhotoIntentId,
      requested_id_intent_id: mockIdIntentId,
    }));

    // Verifies obsolete biometric template encryption was NOT invoked
    expect((faceEngineModule as any).encryptFaceTemplate).toBeUndefined();
    expect(admin.rpcMock).not.toHaveBeenCalledWith('enroll_returning_visitor_v1', expect.anything());
  });

  it('2. Successfully issues returning visitor pass without photo or id upload intents', async () => {
    const admin = setupMocks();
    const res = await passIssueHandler.fetch(makeReturningVisitorRequest());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.publicReference).toBe('77777777-7777-4777-8777-777777777777');

    // Verifies issue_online_pass_v6 was called with registrationMode = 'returning' and null photo/id intents
    expect(admin.rpcMock).toHaveBeenCalledWith('issue_online_pass_v6', expect.objectContaining({
      requested_registration_mode: 'returning',
      requested_photo_intent_id: null,
      requested_id_intent_id: null,
      requested_returning_profile_id: mockProfileId,
    }));
  });

  it('3. Rejects new visitor registration when photoIntentId is missing (fail-closed)', async () => {
    setupMocks();
    const res = await passIssueHandler.fetch(makeNewVisitorRequest({ omitPhoto: true }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toBe('photo_required');
  });

  it('4. Allows returning visitor registration without photoIntentId', async () => {
    const admin = setupMocks();
    const res = await passIssueHandler.fetch(makeReturningVisitorRequest());
    expect(res.status).toBe(201);
    expect(admin.rpcMock).toHaveBeenCalledWith('issue_online_pass_v6', expect.anything());
  });

  it('5. Successfully updates profile info when returning visitor requests saveUpdates', async () => {
    setupMocks();
    const res = await passIssueHandler.fetch(makeReturningVisitorRequest({ saveUpdates: true }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.returningProfileUpdate).toBe('updated');
  });

  it('6. Saves declared vehicle independently when saveVehicle is true', async () => {
    const admin = setupMocks();
    const res = await passIssueHandler.fetch(makeReturningVisitorRequest({ saveVehicle: true }));
    expect(res.status).toBe(201);

    expect(admin.rpcMock).toHaveBeenCalledWith('issue_online_pass_v6', expect.objectContaining({
      requested_save_vehicle: true,
    }));
  });

  it('7. Fails closed when issue_online_pass_v6 throws database error', async () => {
    setupMocks({
      issueRpcErr: { message: 'Database connection failed', code: '500' },
    });
    const res = await passIssueHandler.fetch(makeNewVisitorRequest());
    expect(res.status).toBe(503);
  });
});
