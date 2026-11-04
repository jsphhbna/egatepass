import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import lookupReturningHandler from '../server/routes/passes/lookup-returning.js';
import returningPhotoPreviewHandler, {
  createPreviewToken,
  verifyPreviewToken,
} from '../server/routes/passes/returning-photo-preview.js';
import identifyReturningHandler, { computeMatchTokenDigest } from '../server/routes/passes/identify-returning.js';
import passIssueHandler from '../server/routes/passes/issue.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';

describe('Returning Visitor Privacy Hardening, Profile Linkage & Verification Boundaries', () => {
  const originalEnv = process.env;
  const mockActorId = '11111111-1111-4111-8111-111111111111';
  const mockRequestId = '22222222-2222-4222-8222-222222222222';
  const mockProfileId = '33333333-3333-4333-8333-333333333333';
  const mockPhotoIntentId = '44444444-4444-4444-8444-444444444444';
  const mockIdIntentId = '55555555-5555-4555-8555-555555555555';
  const mockTokenSecret = 'test-token-secret-must-be-at-least-32-chars-long!';

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PASS_TOKEN_SECRET: mockTokenSecret,
      RETURNING_MATCH_TOKEN_SECRET: mockTokenSecret,
      RETURNING_FACE_THRESHOLD_MODE: 'provisional',
      RETURNING_FACE_MIN_COSINE: '0.363',
    };
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  describe('1. Preview Token Signing & Kind Binding (Issue C & F)', () => {
    it('creates a v2 token strictly bound to kind=photo with ~300s TTL', () => {
      const now = Date.now();
      const token = createPreviewToken(mockProfileId, mockTokenSecret, 300, 'photo');
      expect(token).toMatch(/^v2\./);

      const parsed = verifyPreviewToken(token, mockTokenSecret);
      expect(parsed.valid).toBe(true);
      expect(parsed.profileId).toBe(mockProfileId);
      expect(parsed.kind).toBe('photo');

      const parts = token.split('.');
      const exp = parseInt(parts[3], 10);
      expect(exp).toBeGreaterThanOrEqual(Math.floor(now / 1000) + 295);
      expect(exp).toBeLessThanOrEqual(Math.floor(now / 1000) + 305);
    });

    it('creates a v2 token strictly bound to kind=id with ~300s TTL', () => {
      const token = createPreviewToken(mockProfileId, mockTokenSecret, 300, 'id');
      const parsed = verifyPreviewToken(token, mockTokenSecret);
      expect(parsed.valid).toBe(true);
      expect(parsed.profileId).toBe(mockProfileId);
      expect(parsed.kind).toBe('id');
    });

    it('rejects kind swapping: photo preview token cannot authorize id access', () => {
      const photoToken = createPreviewToken(mockProfileId, mockTokenSecret, 300, 'photo');
      const parsed = verifyPreviewToken(photoToken, mockTokenSecret);
      expect(parsed.valid).toBe(true);
      expect(parsed.kind).toBe('photo');
      expect(parsed.kind === 'id').toBe(false);
    });

    it('rejects cross-profile token substitution: profile A token cannot access profile B', () => {
      const profileB = '44444444-4444-4444-8444-444444444444';
      const token = createPreviewToken(mockProfileId, mockTokenSecret, 300, 'photo');
      const parsed = verifyPreviewToken(token, mockTokenSecret);
      expect(parsed.valid).toBe(true);
      expect(parsed.profileId).toBe(mockProfileId);
      expect(parsed.profileId === profileB).toBe(false);
    });

    it('rejects expired preview tokens (>300s)', () => {
      const expiredToken = createPreviewToken(mockProfileId, mockTokenSecret, -10, 'photo');
      const parsed = verifyPreviewToken(expiredToken, mockTokenSecret);
      expect(parsed.valid).toBe(false);
      expect(parsed.expired).toBe(true);
    });

    it('rejects tampered token signature or payload', () => {
      const token = createPreviewToken(mockProfileId, mockTokenSecret, 300, 'photo');
      const tampered = token.slice(0, -4) + 'abcd';
      const parsed = verifyPreviewToken(tampered, mockTokenSecret);
      expect(parsed.valid).toBe(false);
    });
  });

  describe('2. Lookup Returning Hardening (Issue C: Wildcards & Second Factor)', () => {
    it('rejects wildcards %, _, *, \\ in candidate lookup names with 400', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId: mockActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: mockActorId },
        identity: 'test-user',
      } as any);

      for (const badChar of ['%', '_', '*', '\\']) {
        const req = new Request('http://localhost/api/passes/lookup-returning', {
          method: 'POST',
          headers: {
            authorization: 'Bearer token',
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            firstName: `Maria${badChar}`,
            lastName: 'Santos',
            contactNumber: '09171234567',
          }),
        });

        const res = await lookupReturningHandler.fetch(req);
        expect(res.status).toBe(400);
        const json = await res.json();
        expect(json.error).toBe('invalid_request');
      }
    });

    it('rejects candidate lookup when both contactNumber and psgcCityCode are missing', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId: mockActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: mockActorId },
        identity: 'test-user',
      } as any);

      const req = new Request('http://localhost/api/passes/lookup-returning', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          firstName: 'Maria',
          lastName: 'Santos',
        }),
      });

      const res = await lookupReturningHandler.fetch(req);
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).toBe('invalid_request');
    });

    it('caps candidate results at 3 records and provides v2 photo-bound preview tokens', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId: mockActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: mockActorId },
        identity: 'test-user',
      } as any);

      const mockProfiles = [
        {
          id: '22222222-2222-4222-8222-222222222221',
          first_name: 'Maria',
          middle_name: 'Clara',
          last_name: 'Santos',
          contact_number_e164: '+639171234567',
          psgc_barangay_name: 'Barangay 408',
          psgc_city_municipality_name: 'City of Manila',
        },
        {
          id: '22222222-2222-4222-8222-222222222222',
          first_name: 'Maria',
          middle_name: 'Isabel',
          last_name: 'Santos',
          contact_number_e164: '+639171234567',
          psgc_barangay_name: 'Barangay 409',
          psgc_city_municipality_name: 'City of Manila',
        },
        {
          id: '22222222-2222-4222-8222-222222222223',
          first_name: 'Maria',
          middle_name: 'Elena',
          last_name: 'Santos',
          contact_number_e164: '+639171234567',
          psgc_barangay_name: 'Barangay 410',
          psgc_city_municipality_name: 'City of Manila',
        },
        {
          id: '22222222-2222-4222-8222-222222222224',
          first_name: 'Maria',
          middle_name: 'Teresa',
          last_name: 'Santos',
          contact_number_e164: '+639171234567',
          psgc_barangay_name: 'Barangay 411',
          psgc_city_municipality_name: 'City of Manila',
        },
      ];

      const mockAdmin = {
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
        }),
        from: vi.fn().mockReturnValue({
          select: vi.fn().mockReturnThis(),
          ilike: vi.fn().mockReturnThis(),
          gt: vi.fn().mockReturnThis(),
          is: vi.fn().mockReturnThis(),
          limit: vi.fn().mockImplementation((limitCount: number) => {
            return Promise.resolve({
              data: mockProfiles.slice(0, limitCount),
              error: null,
            });
          }),
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        client: {} as any,
      });

      const req = new Request('http://localhost/api/passes/lookup-returning', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          firstName: 'Maria',
          lastName: 'Santos',
          contactNumber: '09171234567',
        }),
      });

      const res = await lookupReturningHandler.fetch(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.candidates.length).toBeLessThanOrEqual(3);

      for (const cand of json.candidates) {
        expect(cand.previewUrl).toContain('&kind=photo');
        const tokenMatch = cand.previewUrl.match(/token=([^&]+)/);
        expect(tokenMatch).not.toBeNull();
        const extractedToken = tokenMatch![1];
        expect(extractedToken).toMatch(/^v2\./);
        const tokenCheck = verifyPreviewToken(extractedToken, mockTokenSecret);
        expect(tokenCheck.valid).toBe(true);
        expect(tokenCheck.kind).toBe('photo');
      }
    });
  });

  describe('3. Returning Photo Preview Endpoint Boundaries (Issue C & E)', () => {
    it('returns 403 forbidden_evidence_kind if client calls endpoint with kind=id using a photo token', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId: mockActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: mockActorId },
        identity: 'test-user',
      } as any);

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: {} as any,
        client: {} as any,
      });

      const photoToken = createPreviewToken(mockProfileId, mockTokenSecret, 300, 'photo');

      const req = new Request(
        `http://localhost/api/passes/returning-photo-preview?profileId=${mockProfileId}&token=${photoToken}&kind=id`,
        {
          method: 'GET',
          headers: {
            authorization: 'Bearer token',
          },
        }
      );

      const res = await returningPhotoPreviewHandler.fetch(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe('forbidden_evidence_kind');
    });

    it('rejects ID preview in provisional mode with 403 provisional_mode_cannot_authorize_id_access', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId: mockActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: mockActorId },
        identity: 'test-user',
      } as any);

      const matchToken = 'test-provisional-match-token-123';

      const mockAdmin = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'returning_identity_attempts') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              gt: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: 'attempt-prov-1',
                  matched_profile_id: mockProfileId,
                  outcome: 'provisional_matched',
                  threshold_mode: 'provisional',
                  expires_at: new Date(Date.now() + 300000).toISOString(),
                },
                error: null,
              }),
            };
          }
          return {};
        }),
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        client: {} as any,
      });

      const req = new Request(
        `http://localhost/api/passes/returning-photo-preview?profileId=${mockProfileId}&token=${matchToken}&kind=id`,
        {
          method: 'GET',
          headers: {
            authorization: 'Bearer token',
          },
        }
      );

      const res = await returningPhotoPreviewHandler.fetch(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toBe('provisional_mode_cannot_authorize_id_access');
    });

    it('consumes ID preview authorization atomically and rejects replay (single-use)', async () => {
      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId: mockActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: mockActorId },
        identity: 'test-user',
      } as any);

      const matchToken = 'test-calibrated-match-token-123';
      let consumed = false;
      const mockAdmin = {
        from: vi.fn().mockImplementation((table: string) => {
          if (table === 'returning_identity_attempts') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              gt: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockReturnThis(),
              update: vi.fn().mockImplementation(() => ({
            eq: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({
                data: [{ id: mockProfileId }],
                error: null,
              }),
            }),
          })),
          maybeSingle: vi.fn().mockImplementation(() => {
                return Promise.resolve({
                  data: {
                    id: 'attempt-cal-1',
                    owner_id: mockActorId,
                    matched_profile_id: mockProfileId,
                    outcome: 'matched',
                    threshold_mode: 'calibrated',
                    expires_at: new Date(Date.now() + 300000).toISOString(),
                    id_preview_consumed_at: consumed ? new Date().toISOString() : null,
                  },
                  error: null,
                });
              }),
            };
          }
          if (table === 'returning_visitor_profiles') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              is: vi.fn().mockReturnThis(),
              gt: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: { id: mockProfileId, expires_at: new Date(Date.now() + 86400000).toISOString() },
                error: null,
              }),
            };
          }
          if (table === 'visitors') {
            return {
              select: vi.fn().mockReturnThis(),
              eq: vi.fn().mockResolvedValue({
                data: [{ id: 'visitor-hist-1' }],
                error: null,
              }),
            };
          }
          if (table === 'visitor_evidence') {
            return {
              select: vi.fn().mockReturnThis(),
              in: vi.fn().mockReturnThis(),
              eq: vi.fn().mockReturnThis(),
              is: vi.fn().mockReturnThis(),
              gt: vi.fn().mockReturnThis(),
              order: vi.fn().mockReturnThis(),
              limit: vi.fn().mockReturnThis(),
              maybeSingle: vi.fn().mockResolvedValue({
                data: {
                  id: 'ev-1',
                  bucket_id: 'visitor-ids',
                  object_path: 'visitor-hist-1/id.jpg',
                  content_type: 'image/jpeg',
                },
                error: null,
              }),
            };
          }
          return {};
        }),
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockImplementation((fnName: string) => {
            if (fnName === 'consume_id_preview_authorization_v1') {
              if (!consumed) {
                consumed = true;
                return Promise.resolve({ data: true, error: null });
              }
              return Promise.resolve({ data: false, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          }),
        }),
        storage: {
          from: vi.fn().mockReturnValue({
            download: vi.fn().mockResolvedValue({
              data: {
                arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]).buffer),
              },
              error: null,
            }),
          }),
        },
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        client: {} as any,
      });

      // First call consumes authorization
      const req1 = new Request(
        `http://localhost/api/passes/returning-photo-preview?profileId=${mockProfileId}&token=${matchToken}&kind=id`,
        {
          method: 'GET',
          headers: {
            authorization: 'Bearer token',
          },
        }
      );
      const res1 = await returningPhotoPreviewHandler.fetch(req1);
      expect(res1.status).toBe(200);

      // Replay attempt fails with 403 id_authorization_already_consumed
      const req2 = new Request(
        `http://localhost/api/passes/returning-photo-preview?profileId=${mockProfileId}&token=${matchToken}&kind=id`,
        {
          method: 'GET',
          headers: {
            authorization: 'Bearer token',
          },
        }
      );
      const res2 = await returningPhotoPreviewHandler.fetch(req2);
      expect(res2.status).toBe(403);
      const json2 = await res2.json();
      expect(json2.error).toBe('id_authorization_already_consumed');
    });
  });

  describe('4. Biometric Mode & Calibration Boundaries (Issue E)', () => {
    it('fails closed when explicit calibrated mode lacks calibration artifact', async () => {
      process.env.RETURNING_FACE_THRESHOLD_MODE = 'calibrated';
      delete process.env.RETURNING_FACE_CALIBRATION_VERSION;
      delete process.env.RETURNING_FACE_CALIBRATION_ARTIFACT;

      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId: mockActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: mockActorId },
        identity: 'test-user',
      } as any);

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: {} as any,
        anon: {} as any,
        client: {} as any,
      });

      const req = new Request('http://localhost/api/passes/identify-returning', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          profileId: mockProfileId,
          photoIntentId: '44444444-4444-4444-8444-444444444444',
          requestId: '55555555-5555-4555-8555-555555555555',
        }),
      });

      const res = await identifyReturningHandler.fetch(req);
      // Graceful fail-closed: biometrics report unavailable pending calibration configuration
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.available).toBe(false);
      expect(json.matched).toBe(false);
    });
  });

  describe('5. Pass Issuance & saveUpdates Propagation (Issue B & D)', () => {
    function setupIssueMocks(overrides: {
      isReturning?: boolean;
      saveUpdates?: boolean;
    } = {}) {
      let capturedRpcParams: any = null;

      vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
        actorId: mockActorId,
        role: 'visitor',
        isAnonymous: true,
        isRecoverySession: false,
        user: { id: mockActorId },
        identity: 'test-user',
      } as any);

      function createQueryBuilder(table: string) {
        const q: any = {
          _table: table,
          _filters: {} as Record<string, any>,
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockImplementation((col: string, val: any) => {
            q._filters[col] = val;
            return q;
          }),
          is: vi.fn().mockReturnThis(),
          in: vi.fn().mockImplementation((col: string, val: any) => {
            if (table === 'psgc_locations') {
              return Promise.resolve({
                data: [
                  { psgc_code: '1300000000', name: 'National Capital Region', level: 'region' },
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
                },
                error: null,
              });
            }
            return Promise.resolve({ data: null, error: null });
          }),
          update: vi.fn().mockImplementation(() => ({
            eq: vi.fn().mockReturnValue({
              select: vi.fn().mockResolvedValue({
                data: [{ id: mockProfileId }],
                error: null,
              }),
            }),
          })),
          maybeSingle: vi.fn().mockImplementation(() => {
            if (table === 'passes') {
              return Promise.resolve({ data: null, error: null });
            }
            if (table === 'upload_intents') {
              const isId = q._filters.id === mockIdIntentId;
              const kind = isId ? 'id' : 'photo';
              const bucket = isId ? 'visitor-ids' : 'visitor-photos';
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
        };
        return q;
      }

      const mockAdmin = {
        from: vi.fn().mockImplementation((table: string) => createQueryBuilder(table)),
        schema: vi.fn().mockReturnValue({
          rpc: vi.fn().mockImplementation((fnName: string, params: any) => {
            if (fnName === 'consume_rate_limit') {
              return Promise.resolve({ data: true, error: null });
            }
            if (fnName === 'issue_online_pass_v6') {
              capturedRpcParams = params;
              const result = {
                data: {
                  pass_id: '66666666-6666-4666-8666-666666666666',
                  public_reference: '77777777-7777-4777-8777-777777777777',
                  valid_from: new Date().toISOString(),
                  valid_until: new Date(Date.now() + 86400000).toISOString(),
                },
                error: null,
              };
              return {
                single: vi.fn().mockResolvedValue(result),
                then: (resolve: any) => resolve(result),
              };
            }
            return Promise.resolve({ data: null, error: null });
          }),
        }),
        storage: {
          from: vi.fn().mockReturnValue({
            download: vi.fn().mockResolvedValue({
              data: {
                arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]).buffer),
              },
              error: null,
            }),
          }),
        },
      };

      vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
        admin: mockAdmin as any,
        client: {} as any,
      });

      return {
        getRpcParams: () => capturedRpcParams,
      };
    }

    it('passes requested_save_profile_updates=false into RPC when saveUpdates is false', async () => {
      const mockState = setupIssueMocks({ isReturning: true, saveUpdates: false });

      const req = new Request('http://localhost/api/passes/issue', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requestId: mockRequestId,
          source: 'portal',
          registrationMode: 'returning',
          arrivalMode: 'no_vehicle',
          visitor: {
            firstName: 'Maria',
            lastName: 'Santos',
            contactNumber: '09171234567',
            purpose: 'Official Campus Visit',
            visitDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
          },
          psgc: {
            version: '2026-q3',
            regionCode: '1300000000',
            provinceCode: null,
            cityCode: '1380600000',
            barangayCode: '1380606014',
          },
          returning: {
            profileId: mockProfileId,
            matchToken: 'test-match-token-123456',
            saveUpdates: false,
          },
        }),
      });

      const res = await passIssueHandler.fetch(req);
      expect(res.status).toBe(201);
      const params = mockState.getRpcParams();
      expect(params).toBeDefined();
      expect(params.requested_save_profile_updates).toBe(false);
      expect(params.requested_returning_profile_id).toBe(mockProfileId);
    });

    it('passes requested_save_profile_updates=true into RPC when saveUpdates is true', async () => {
      const mockState = setupIssueMocks({ isReturning: true, saveUpdates: true });

      const req = new Request('http://localhost/api/passes/issue', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requestId: mockRequestId,
          source: 'portal',
          registrationMode: 'returning',
          arrivalMode: 'no_vehicle',
          visitor: {
            firstName: 'Maria',
            lastName: 'Santos',
            contactNumber: '09171234567',
            purpose: 'Official Campus Visit',
            visitDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
          },
          psgc: {
            version: '2026-q3',
            regionCode: '1300000000',
            provinceCode: null,
            cityCode: '1380600000',
            barangayCode: '1380606014',
          },
          returning: {
            profileId: mockProfileId,
            matchToken: 'test-match-token-123456',
            saveUpdates: true,
          },
        }),
      });

      const res = await passIssueHandler.fetch(req);
      expect(res.status).toBe(201);
      const params = mockState.getRpcParams();
      expect(params).toBeDefined();
      expect(params.requested_save_profile_updates).toBe(true);
    });

    it('sets requested_save_profile_updates=false and no returning profile ID when registrationMode=new', async () => {
      const mockState = setupIssueMocks({ isReturning: false });

      const req = new Request('http://localhost/api/passes/issue', {
        method: 'POST',
        headers: {
          authorization: 'Bearer token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          requestId: mockRequestId,
          source: 'portal',
          registrationMode: 'new',
          arrivalMode: 'no_vehicle',
          visitor: {
            firstName: 'Maria',
            lastName: 'Santos',
            contactNumber: '09171234567',
            purpose: 'Official Campus Visit',
            visitDate: new Date(Date.now() + 86400000).toISOString().split('T')[0],
          },
          psgc: {
            version: '2026-q3',
            regionCode: '1300000000',
            provinceCode: null,
            cityCode: '1380600000',
            barangayCode: '1380606014',
          },
          photoIntentId: mockPhotoIntentId,
          idIntentId: mockIdIntentId,
        }),
      });

      const res = await passIssueHandler.fetch(req);
      expect(res.status).toBe(201);
      const params = mockState.getRpcParams();
      expect(params).toBeDefined();
      expect(params.requested_registration_mode).toBe('new');
      expect(params.requested_returning_profile_id).toBeNull();
      expect(params.requested_save_profile_updates).toBe(false);
    });
  });
});
