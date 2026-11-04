import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import passIssueHandler from '../server/routes/passes/issue.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';
import * as faceEngineModule from '../server/lib/face-engine.js';

describe('Returning Visitor Enrollment Fail-Closed & Atomicity Invariants', () => {
  const originalEnv = process.env;
  const mockActorId = '11111111-1111-4111-8111-111111111111';
  const mockRequestId = '22222222-2222-4222-8222-222222222222';
  const mockPassId = '33333333-3333-4333-8333-333333333333';
  const mockVisitorId = '44444444-4444-4444-8444-444444444444';
  const mockPhotoIntentId = '55555555-5555-4555-8555-555555555555';
  const mockIdIntentId = '66666666-6666-4666-8666-666666666666';

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PASS_TOKEN_SECRET: 'test-pass-token-secret-must-be-at-least-32-chars!',
      RETURNING_VISITOR_TEMPLATE_KEY: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  function setupMocks(overrides: {
    passRow?: any;
    passErr?: any;
    visitorRow?: any;
    visitorErr?: any;
    enrollRpcRes?: any;
    enrollRpcErr?: any;
  } = {}) {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: mockActorId } as any,
      isAnonymous: true,
      isRecoverySession: false,
    });

    vi.spyOn(faceEngineModule, 'extractFaceDescriptorFromBuffer').mockResolvedValue({
      descriptor: new Float32Array(128).fill(0.1),
      modelName: 'sface-v1',
      modelVersion: '1.0.0',
    });

    vi.spyOn(faceEngineModule, 'validateFaceDescriptor').mockReturnValue({ valid: true });
    vi.spyOn(faceEngineModule, 'getActiveTemplateKeyVersion').mockReturnValue('v1');
    vi.spyOn(faceEngineModule, 'encryptFaceTemplate').mockReturnValue({
      encryptedEmbedding: 'a'.repeat(64),
      iv: 'b'.repeat(32),
      authTag: 'c'.repeat(32),
      keyVersion: 'v1',
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
            if (q._filters.id) {
              return Promise.resolve({
                data: overrides.passRow !== undefined ? overrides.passRow : {
                  id: mockPassId,
                  visitor_id: mockVisitorId,
                  issue_request_id: mockRequestId,
                },
                error: overrides.passErr || null,
              });
            }
          }
          if (table === 'visitors') {
            return Promise.resolve({
              data: overrides.visitorRow !== undefined ? overrides.visitorRow : {
                id: mockVisitorId,
                owner_id: mockActorId,
                returning_profile_id: null,
              },
              error: overrides.visitorErr || null,
            });
          }
          if (table === 'upload_intents') {
            const isId = q._filters.id === mockIdIntentId;
            return Promise.resolve({
              data: {
                id: q._filters.id || mockPhotoIntentId,
                owner_id: mockActorId,
                source: 'portal',
                kind: isId ? 'id' : 'photo',
                bucket_id: isId ? 'visitor-ids' : 'visitor-photos',
                object_path: `portal/${mockActorId}/${isId ? 'id' : 'photo'}.jpg`,
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
          return Promise.resolve({ data: null, error: null });
        }),
      };
      return q;
    }

    const rpcMock = vi.fn().mockImplementation((fn: string) => {
      if (fn === 'consume_rate_limit') {
        return Promise.resolve({ data: true, error: null });
      }
      if (fn === 'issue_online_pass_v6') {
        return {
          single: vi.fn().mockResolvedValue({
            data: {
              pass_id: mockPassId,
              public_reference: '77777777-7777-4777-8777-777777777777',
              valid_from: new Date().toISOString(),
              valid_until: new Date(Date.now() + 86400000).toISOString(),
            },
            error: null,
          }),
        };
      }
      if (fn === 'enroll_returning_visitor_v1') {
        return {
          single: vi.fn().mockResolvedValue({
            data: overrides.enrollRpcRes !== undefined ? overrides.enrollRpcRes : {
              returning_profile_id: '88888888-8888-4888-8888-888888888888',
            },
            error: overrides.enrollRpcErr || null,
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

  function makeRequest(enrollReturning = true) {
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
          postalCode: '1008',
          postalCodeSource: 'PHLPost',
        },
        photoIntentId: mockPhotoIntentId,
        idIntentId: mockIdIntentId,
        enrollReturning,
      }),
    });
  }

  it('1. Successfully issues pass and enrolls returning profile in atomic transaction', async () => {
    setupMocks();
    const res = await passIssueHandler.fetch(makeRequest(true));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.publicReference).toBe('77777777-7777-4777-8777-777777777777');
    expect(body.returningEnrollment).toBe('enrolled');
  });

  it('2. Fails closed when pass_id is missing: pass is preserved, enrollment marked failed', async () => {
    const admin = setupMocks();
    // Simulate pass_id not returned by issuance RPC
    admin.schema = vi.fn().mockReturnValue({
      rpc: vi.fn().mockImplementation((fn: string) => {
        if (fn === 'consume_rate_limit') {
          return Promise.resolve({ data: true, error: null });
        }
        if (fn === 'issue_online_pass_v6') {
          return {
            single: vi.fn().mockResolvedValue({
              data: {
                pass_id: null, // missing pass_id
                public_reference: '77777777-7777-4777-8777-777777777777',
                valid_from: new Date().toISOString(),
                valid_until: new Date(Date.now() + 86400000).toISOString(),
              },
              error: null,
            }),
          };
        }
        return { single: vi.fn().mockResolvedValue({ data: null, error: null }) };
      }),
    });

    const res = await passIssueHandler.fetch(makeRequest(true));
    expect(res.status).toBe(201);
    const body = await res.json();
    // Pass is preserved!
    expect(body.publicReference).toBe('77777777-7777-4777-8777-777777777777');
    expect(body.returningEnrollment).toBe('failed');
  });

  it('3. Fails closed when pass lookup throws error: enrollment marked failed', async () => {
    setupMocks({ passErr: { message: 'Database connection failed', code: '500' } });
    const res = await passIssueHandler.fetch(makeRequest(true));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.publicReference).toBe('77777777-7777-4777-8777-777777777777');
    expect(body.returningEnrollment).toBe('failed');
  });

  it('4. Fails closed when visitor owner does not match actorId: enrollment aborted', async () => {
    setupMocks({
      visitorRow: {
        id: mockVisitorId,
        owner_id: '99999999-9999-4999-8999-999999999999', // Different actor!
        returning_profile_id: null,
      },
    });

    const res = await passIssueHandler.fetch(makeRequest(true));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.publicReference).toBe('77777777-7777-4777-8777-777777777777');
    expect(body.returningEnrollment).toBe('failed');
  });

  it('5. Fails closed when visitor is already linked to a returning profile: enrollment aborted', async () => {
    setupMocks({
      visitorRow: {
        id: mockVisitorId,
        owner_id: mockActorId,
        returning_profile_id: 'existing-profile-id', // Already enrolled!
      },
    });

    const res = await passIssueHandler.fetch(makeRequest(true));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.publicReference).toBe('77777777-7777-4777-8777-777777777777');
    expect(body.returningEnrollment).toBe('failed');
  });

  it('6. Fails closed when enroll_returning_visitor_v1 transactional RPC throws: enrollment marked failed', async () => {
    setupMocks({
      enrollRpcErr: { message: 'duplicate key value violates unique constraint', code: '23505' },
    });

    const res = await passIssueHandler.fetch(makeRequest(true));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.publicReference).toBe('77777777-7777-4777-8777-777777777777');
    expect(body.returningEnrollment).toBe('failed');
  });

  it('7. Does not attempt enrollment when enrollReturning is false or omitted', async () => {
    setupMocks();
    const res = await passIssueHandler.fetch(makeRequest(false));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.publicReference).toBe('77777777-7777-4777-8777-777777777777');
    expect(body.returningEnrollment).toBe('not_requested');
  });

  it('8. Declining biometric enrollment creates normal pass and visitor records without touching returning profiles', async () => {
    const mockAdmin = setupMocks();
    const res = await passIssueHandler.fetch(makeRequest(false));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.passId).toBe('77777777-7777-4777-8777-777777777777');
    expect(body.publicReference).toBe('77777777-7777-4777-8777-777777777777');
    expect(body.returningEnrollment).toBe('not_requested');
    // Verify that the returning enrollment RPC is never invoked when biometric consent is false
    expect(mockAdmin.rpcMock).not.toHaveBeenCalledWith('enroll_returning_visitor_v1', expect.anything());
  });
});
