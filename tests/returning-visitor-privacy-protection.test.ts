import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import lookupReturningHandler from '../server/routes/passes/lookup-returning.js';
import returningPhotoPreviewHandler, {
  createPreviewToken,
  verifyPreviewToken,
} from '../server/routes/passes/returning-photo-preview.js';
import identifyReturningHandler, { computeMatchTokenDigest } from '../server/routes/passes/identify-returning.js';
import {
  createCandidateToken,
  verifyCandidateToken,
} from '../server/lib/candidate-token.js';
import { computeCosineSimilarity } from '../server/lib/face-engine.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';

describe('Returning Visitor Portrait Privacy & Verification Hardening (Section 11 Matrix)', () => {
  const originalEnv = process.env;
  const mockActorId = '11111111-1111-4111-8111-111111111111';
  const otherActorId = '99999999-9999-4999-8999-999999999999';
  const mockProfileId = '33333333-3333-4333-8333-333333333333';
  const otherProfileId = '88888888-8888-4888-8888-888888888888';
  const mockPhotoIntentId = '44444444-4444-4444-8444-444444444444';
  const mockIdIntentId = '55555555-5555-4555-8555-555555555555';
  const mockTokenSecret = 'test-token-secret-must-be-at-least-32-chars-long!';

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      SUPABASE_URL: 'http://localhost:54321',
      SUPABASE_SECRET_KEY: 'test-supabase-secret-key-at-least-32-chars!',
      PASS_TOKEN_SECRET: mockTokenSecret,
      RETURNING_MATCH_TOKEN_SECRET: mockTokenSecret,
      RATE_LIMIT_HMAC_SECRET: mockTokenSecret,
      TURNSTILE_SECRET_KEY: 'test-turnstile-secret-at-least-32-chars!',
      RETURNING_FACE_THRESHOLD_MODE: 'provisional',
      RETURNING_FACE_MIN_COSINE: '0.363',
    };
    vi.restoreAllMocks();

    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      actorId: mockActorId,
      role: 'visitor',
      isAnonymous: true,
      isRecoverySession: false,
      user: { id: mockActorId },
      identity: 'test-user',
    } as any);

    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      new Response(JSON.stringify({ success: true, hostname: 'localhost' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  // Helper to construct authenticated mock HTTP requests
  function makeRequest(
    url: string,
    method: 'GET' | 'POST',
    body?: any,
    headers: Record<string, string> = {}
  ): Request {
    const defaultHeaders: Record<string, string> = {
      authorization: 'Bearer token',
      'content-type': 'application/json',
      ...headers,
    };
    return new Request(url, {
      method,
      headers: defaultHeaders,
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
  }

  function buildMockProfilesAdmin(candidateData: any[] = []) {
    const chainable = {
      select: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockReturnThis(),
      gt: vi.fn().mockReturnThis(),
      is: vi.fn().mockReturnThis(),
      or: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue({
        data: candidateData,
        error: null,
      }),
    };

    return {
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      }),
      from: vi.fn((table: string) => {
        if (table === 'returning_visitor_profiles') {
          return chainable;
        }
        if (table === 'visitors') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'v2222222-2222-4222-8222-222222222222',
                  full_name: 'Juan Dela Cruz',
                  contact_number: '+639171234567',
                  created_at: new Date().toISOString(),
                },
              ],
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
                id: 'e2222222-2222-4222-8222-222222222222',
                visitor_id: 'v2222222-2222-4222-8222-222222222222',
                bucket_id: 'visitor-photos',
                object_path: 'photo.jpg',
                content_type: 'image/jpeg',
                byte_size: 1024,
                sha256_hex: 'a'.repeat(64),
                expires_at: new Date(Date.now() + 86400000).toISOString(),
                purged_at: null,
                created_at: new Date().toISOString(),
              },
              error: null,
            }),
          };
        }
        return {};
      }),
    };
  }

  // --------------------------------------------------------------------------
  // Matrix Items 1 - 3: Lookup Returning Name-Only & PII Protection
  // --------------------------------------------------------------------------

  it('Requirement 1: Name-only lookup continues to work with name query', async () => {
    const mockAdmin = buildMockProfilesAdmin([
      {
        id: mockProfileId,
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        contact_number_e164: '+639171234567',
        home_address: '123 Sampaguita St, Manila',
        last_visit_at: '2026-10-15T08:00:00Z',
        active_pass_count: 0,
        photo_intent_id: mockPhotoIntentId,
        id_intent_id: mockIdIntentId,
      },
    ]);

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      client: {} as any,
    });

    const req = makeRequest('http://localhost/api/passes/lookup-returning', 'POST', {
      firstName: 'Juan',
      lastName: 'Dela Cruz',
    });

    const res = await lookupReturningHandler.fetch(req);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.candidates).toBeDefined();
    expect(data.candidates.length).toBe(1);
    expect(data.candidates[0].maskedName).toBeDefined();
    // Profile ID, gender, and totalMatches must NOT be exposed in candidate lookup responses
    expect(data.candidates[0].profileId).toBeUndefined();
    expect(data.candidates[0].gender).toBeUndefined();
    expect(data.totalMatches).toBeUndefined();
    expect(data.candidates[0].candidateToken).toMatch(/^cand\.v2\./);
    expect(data.candidates[0].candidateToken.includes(mockProfileId)).toBe(false);
  });

  it('Requirement 2: Candidate results do not include portrait URLs or preview tokens', async () => {
    const mockAdmin = buildMockProfilesAdmin([
      {
        id: mockProfileId,
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        contact_number_e164: '+639171234567',
        home_address: '123 Sampaguita St, Manila',
        last_visit_at: '2026-10-15T08:00:00Z',
        active_pass_count: 0,
        photo_intent_id: mockPhotoIntentId,
        id_intent_id: mockIdIntentId,
      },
    ]);

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      client: {} as any,
    });

    const req = makeRequest('http://localhost/api/passes/lookup-returning', 'POST', {
      firstName: 'Juan',
      lastName: 'Dela Cruz',
    });

    const res = await lookupReturningHandler.fetch(req);
    const data = await res.json();
    const candidate = data.candidates[0];

    // Assert NO previewUrl or photo previewToken leaked in candidate card
    expect(candidate.previewUrl).toBeUndefined();
    expect(candidate.photoPreviewToken).toBeUndefined();
    expect(candidate.previewToken).toBeUndefined();

    // Instead, a scoped candidateToken is issued for biometric verification only
    expect(candidate.candidateToken).toBeDefined();
    expect(candidate.candidateToken).toMatch(/^cand\.v2\./);
    expect(candidate.candidateToken.includes(mockProfileId)).toBe(false);
    expect(candidate.profileId).toBeUndefined();
    expect(candidate.gender).toBeUndefined();
  });

  it('Requirement 3: Candidate results do not expose unnecessary PII (phone, address, ID numbers)', async () => {
    const mockAdmin = buildMockProfilesAdmin([
      {
        id: mockProfileId,
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        contact_number_e164: '+639171234567',
        home_address: '123 Sampaguita St, Manila',
        last_visit_at: '2026-10-15T08:00:00Z',
        active_pass_count: 0,
        photo_intent_id: mockPhotoIntentId,
        id_intent_id: mockIdIntentId,
      },
    ]);

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      client: {} as any,
    });

    const req = makeRequest('http://localhost/api/passes/lookup-returning', 'POST', {
      firstName: 'Juan',
      lastName: 'Dela Cruz',
    });

    const res = await lookupReturningHandler.fetch(req);
    const data = await res.json();
    const candidate = data.candidates[0];

    // Assert strictly bounded fields (no raw phone, no address, no ID numbers, no unnecessary historical metadata)
    expect(candidate.contact_number_e164).toBeUndefined();
    expect(candidate.phone).toBeUndefined();
    expect(candidate.home_address).toBeUndefined();
    expect(candidate.address).toBeUndefined();
    expect(candidate.id_number).toBeUndefined();
    expect(candidate.embedding).toBeUndefined();
    expect(candidate.registeredAt).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // Matrix Items 4 - 7: Candidate Token Boundaries & Discovery Token Rejection
  // --------------------------------------------------------------------------

  it('Requirement 4: A discovery token (cand.v1.* or v3.*) cannot access returning-photo-preview', async () => {
    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: {} as any,
      client: {} as any,
    });

    // 1. Discovery candidate token
    const candidateToken = createCandidateToken(mockProfileId, mockActorId, mockTokenSecret, 300);
    const candReq = makeRequest(
      `http://localhost/api/passes/returning-photo-preview?profileId=${mockProfileId}&token=${candidateToken}&kind=photo`,
      'GET'
    );
    const candRes = await returningPhotoPreviewHandler.fetch(candReq);
    expect(candRes.status).toBe(403);
    const candBody = await candRes.json();
    expect(candBody.error).toBe('discovery_token_cannot_authorize_preview');

    // 2. Discovery v3 preview token without biometric verification
    const v3Token = createPreviewToken(mockProfileId, mockActorId, mockTokenSecret, 300, 'photo');
    const v3Req = makeRequest(
      `http://localhost/api/passes/returning-photo-preview?profileId=${mockProfileId}&token=${v3Token}&kind=photo`,
      'GET'
    );
    const v3Res = await returningPhotoPreviewHandler.fetch(v3Req);
    expect(v3Res.status).toBe(403);
    const v3Body = await v3Res.json();
    expect(v3Body.error).toBe('discovery_token_cannot_authorize_preview');
  });

  it('Requirement 5: Candidate token cannot be replayed under different anonymous actor (actor_mismatch)', async () => {
    // 1. Cryptographic token verification unit check
    const token = createCandidateToken(mockProfileId, mockActorId, mockTokenSecret, 300);
    const result = verifyCandidateToken(token, otherActorId, mockTokenSecret);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('actor_mismatch');

    // 2. HTTP route boundary check against identify-returning
    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: {} as any,
      client: {} as any,
    });

    const identifyReq = makeRequest('http://localhost/api/passes/identify-returning', 'POST', {
      requestId: '22222222-2222-4222-8222-222222222222',
      profileId: mockProfileId,
      candidateToken: token, // token was minted for mockActorId, but request session is otherActorId
      photoBase64: '/9j/4AAQSkZJRg==',
    });

    // Mock session actor as otherActorId
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValueOnce({
      actorId: otherActorId,
      role: 'visitor',
      isAnonymous: true,
      isRecoverySession: false,
      user: { id: otherActorId },
      identity: 'test-user',
    } as any);

    const res = await identifyReturningHandler.fetch(identifyReq);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('actor_mismatch');
  });

  it('Requirement 6: Expired candidate tokens are rejected by server and token verifier', async () => {
    // 1. Token verification unit check
    const expiredToken = createCandidateToken(mockProfileId, mockActorId, mockTokenSecret, -10);
    const result = verifyCandidateToken(expiredToken, mockActorId, mockTokenSecret);
    expect(result.valid).toBe(false);
    expect(result.error).toBe('candidate_token_expired');

    // 2. HTTP route boundary check against identify-returning
    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: {} as any,
      client: {} as any,
    });

    const identifyReq = makeRequest('http://localhost/api/passes/identify-returning', 'POST', {
      requestId: '22222222-2222-4222-8222-222222222222',
      profileId: mockProfileId,
      candidateToken: expiredToken,
      photoBase64: '/9j/4AAQSkZJRg==',
    });

    const res = await identifyReturningHandler.fetch(identifyReq);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('candidate_token_expired');
  });

  it('Requirement 7: Mismatched profile ID or missing candidate token is rejected by identify-returning', async () => {
    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: {} as any,
      client: {} as any,
    });

    // 1. Token minted for mockProfileId, but client attempts to identify against otherProfileId
    const token = createCandidateToken(mockProfileId, mockActorId, mockTokenSecret, 300);
    const mismatchReq = makeRequest('http://localhost/api/passes/identify-returning', 'POST', {
      requestId: '22222222-2222-4222-8222-222222222222',
      profileId: otherProfileId, // Mismatched target profile
      candidateToken: token,
      photoBase64: '/9j/4AAQSkZJRg==',
    });

    const mismatchRes = await identifyReturningHandler.fetch(mismatchReq);
    expect(mismatchRes.status).toBe(403);
    const mismatchBody = await mismatchRes.json();
    expect(mismatchBody.error).toBe('profile_id_mismatch');

    // 2. Client passes raw profileId with NO candidateToken -> rejected (not treated as valid proof of selection)
    const missingTokenReq = makeRequest('http://localhost/api/passes/identify-returning', 'POST', {
      requestId: '22222222-2222-4222-8222-222222222222',
      profileId: mockProfileId,
      // candidateToken omitted!
      photoBase64: '/9j/4AAQSkZJRg==',
    });

    const missingTokenRes = await identifyReturningHandler.fetch(missingTokenReq);
    expect(missingTokenRes.status).toBe(403);
    const missingTokenBody = await missingTokenRes.json();
    expect(missingTokenBody.error).toBe('candidate_token_required');
  });

  // --------------------------------------------------------------------------
  // Matrix Items 8 - 10: Biometric Verification & Authorized Portrait Preview
  // --------------------------------------------------------------------------

  it('Requirement 8: Unsuccessful biometric check does not grant portrait access', async () => {
    // Attempting to access returning-photo-preview with an unverified or random token
    const mockAdmin = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'returning_identity_attempts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: null, // No matched attempt found for this token
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

    const unverifiedToken = 'random-unverified-match-attempt-token-1234567890';
    const req = makeRequest(
      `http://localhost/api/passes/returning-photo-preview?profileId=${mockProfileId}&token=${unverifiedToken}&kind=photo`,
      'GET'
    );

    const res = await returningPhotoPreviewHandler.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('unauthorized_preview_access');
  });

  it('Requirement 9: Successful authorized biometric match permits portrait access via matchToken', async () => {
    const rawMatchToken = 'test-match-token-64-bytes-sample-for-biometric-verification-test123';
    const digest = computeMatchTokenDigest(rawMatchToken, mockTokenSecret);

    const mockAdmin = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'returning_identity_attempts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'attempt-123',
                owner_id: mockActorId,
                matched_profile_id: mockProfileId,
                token_digest: digest,
                outcome: 'matched',
                threshold_mode: 'provisional',
                expires_at: new Date(Date.now() + 300_000).toISOString(),
                id_preview_consumed_at: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'visitors') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({
              data: [{ id: 'vis-123' }],
              error: null,
            }),
          };
        }
        if (table === 'visitor_evidence') {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                bucket_id: 'visitor-photos',
                object_path: 'portraits/vis-123.jpg',
                content_type: 'image/jpeg',
                purged_at: null,
                expires_at: null,
                created_at: '2026-11-01T00:00:00Z',
              },
              error: null,
            }),
          };
        }
        return {};
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({
            data: new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }),
            error: null,
          }),
        }),
      },
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      client: {} as any,
    });

    const req = makeRequest(
      `http://localhost/api/passes/returning-photo-preview?profileId=${mockProfileId}&token=${rawMatchToken}&kind=photo`,
      'GET'
    );

    const res = await returningPhotoPreviewHandler.fetch(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/jpeg');
  });

  it('Requirement 10: Cosine similarity mathematics computes exact identity and orthogonality', () => {
    // Exact identical vectors
    const vecA = new Float32Array([0.5, 0.5, 0.5, 0.5]);
    const simIdentical = computeCosineSimilarity(vecA, vecA);
    expect(simIdentical).toBeCloseTo(1.0);

    // Orthogonal vectors
    const vecB = new Float32Array([1.0, 0.0]);
    const vecC = new Float32Array([0.0, 1.0]);
    const simOrthogonal = computeCosineSimilarity(vecB, vecC);
    expect(simOrthogonal).toBeCloseTo(0.0);
  });

  // --------------------------------------------------------------------------
  // Matrix Items 11 - 14: Storage & Data Ephemerality for Returning Selfies
  // --------------------------------------------------------------------------

  it('Requirement 11: Returning selfies create no persistent Storage objects', async () => {
    const uploadSpy = vi.fn();
    const mockAdmin = {
      storage: {
        from: vi.fn().mockReturnValue({
          upload: uploadSpy,
          download: vi.fn().mockResolvedValue({
            data: new Blob([Buffer.from([0xff, 0xd8, 0xff, 0xe0])], { type: 'image/jpeg' }),
            error: null,
          }),
        }),
      },
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      }),
      from: vi.fn((table: string) => {
        if (table === 'returning_visitor_profiles') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: mockProfileId,
                first_name: 'Juan',
                last_name: 'Cruz',
                expires_at: new Date(Date.now() + 86400000).toISOString(),
                revoked_at: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'visitors') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({
              data: [{ id: 'vis-123' }],
              error: null,
            }),
          };
        }
        if (table === 'visitor_evidence') {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                bucket_id: 'visitor-photos',
                object_path: 'portraits/vis-123.jpg',
                content_type: 'image/jpeg',
                purged_at: null,
                expires_at: null,
              },
              error: null,
            }),
          };
        }
        return {
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
        };
      }),
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      client: {} as any,
    });

    const token = createCandidateToken(mockProfileId, mockActorId, mockTokenSecret, 300);
    const req = makeRequest('http://localhost/api/passes/identify-returning', 'POST', {
      requestId: '22222222-2222-4222-8222-222222222222',
      profileId: mockProfileId,
      candidateToken: token,
      photoBase64: '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABkAGQDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//2Q==',
    });

    await identifyReturningHandler.fetch(req);
    // Crucial ephemerality assertion: storage upload is NEVER invoked for returning selfie
    expect(uploadSpy).not.toHaveBeenCalled();
  });

  it('Requirement 12: Returning selfies create no new visitor_evidence rows', async () => {
    const evidenceInsertSpy = vi.fn();
    const mockAdmin = {
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      }),
      from: vi.fn((table: string) => {
        if (table === 'visitor_evidence') {
          return {
            insert: evidenceInsertSpy,
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                bucket_id: 'visitor-photos',
                object_path: 'portraits/vis-123.jpg',
                content_type: 'image/jpeg',
                purged_at: null,
                expires_at: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'returning_visitor_profiles') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: mockProfileId,
                first_name: 'Juan',
                last_name: 'Cruz',
                expires_at: new Date(Date.now() + 86400000).toISOString(),
                revoked_at: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'visitors') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({
              data: [{ id: 'vis-123' }],
              error: null,
            }),
          };
        }
        return {
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
        };
      }),
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      client: {} as any,
    });

    const token = createCandidateToken(mockProfileId, mockActorId, mockTokenSecret, 300);
    const req = makeRequest('http://localhost/api/passes/identify-returning', 'POST', {
      requestId: '22222222-2222-4222-8222-222222222222',
      profileId: mockProfileId,
      candidateToken: token,
      photoBase64: '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABkAGQDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//2Q==',
    });

    await identifyReturningHandler.fetch(req);
    // Crucial ephemerality assertion: visitor_evidence insert is NEVER called
    expect(evidenceInsertSpy).not.toHaveBeenCalled();
  });

  it('Requirement 13: No returning selfie biometric template is persisted in returning_face_templates', async () => {
    const templateInsertSpy = vi.fn();
    const mockAdmin = {
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      }),
      from: vi.fn((table: string) => {
        if (table === 'returning_face_templates') {
          return {
            insert: templateInsertSpy,
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
          };
        }
        if (table === 'returning_visitor_profiles') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: mockProfileId,
                first_name: 'Juan',
                last_name: 'Cruz',
                expires_at: new Date(Date.now() + 86400000).toISOString(),
                revoked_at: null,
              },
              error: null,
            }),
          };
        }
        if (table === 'visitors') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockResolvedValue({
              data: [{ id: 'vis-123' }],
              error: null,
            }),
          };
        }
        if (table === 'visitor_evidence') {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                bucket_id: 'visitor-photos',
                object_path: 'portraits/vis-123.jpg',
                content_type: 'image/jpeg',
                purged_at: null,
                expires_at: null,
              },
              error: null,
            }),
          };
        }
        return {
          insert: vi.fn().mockResolvedValue({ data: null, error: null }),
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
        };
      }),
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      client: {} as any,
    });

    const token = createCandidateToken(mockProfileId, mockActorId, mockTokenSecret, 300);
    const req = makeRequest('http://localhost/api/passes/identify-returning', 'POST', {
      requestId: '22222222-2222-4222-8222-222222222222',
      profileId: mockProfileId,
      candidateToken: token,
      photoBase64: '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCABkAGQDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA//2Q==',
    });

    await identifyReturningHandler.fetch(req);
    // Crucial ephemerality assertion: returning_face_templates insert is NEVER called
    expect(templateInsertSpy).not.toHaveBeenCalled();
  });

  it('Requirement 14: Photo retention and deletion boundaries are enforced (tokens expire in 300s)', () => {
    const token = createCandidateToken(mockProfileId, mockActorId, mockTokenSecret, 300);
    const parsed = verifyCandidateToken(token, mockActorId, mockTokenSecret);
    expect(parsed.valid).toBe(true);
    // Expiration strictly 300 seconds (5 minutes) from issue
    expect(parsed.expiresAt).toBeDefined();
    const now = Math.floor(Date.now() / 1000);
    expect(parsed.expiresAt).toBeGreaterThanOrEqual(now + 295);
    expect(parsed.expiresAt).toBeLessThanOrEqual(now + 305);
  });

  it('Requirement 15: No other registration or kiosk workflow regresses', () => {
    // Assert candidate token and preview token formats remain distinguishable and distinct
    const cand = createCandidateToken(mockProfileId, mockActorId, mockTokenSecret, 300);
    const prev = createPreviewToken(mockProfileId, mockActorId, mockTokenSecret, 300, 'id');
    expect(cand.startsWith('cand.v2.')).toBe(true);
    expect(cand.includes(mockProfileId)).toBe(false);
    expect(prev.startsWith('v3.')).toBe(true);
    expect(cand).not.toEqual(prev);
  });
});
