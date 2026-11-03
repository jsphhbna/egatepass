import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import returningIdPreviewHandler from '../server/routes/passes/returning-id-preview.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';
import { computeMatchTokenDigest } from '../server/routes/passes/identify-returning.js';

describe('Secure Historical ID Preview Endpoint (/api/passes/returning-id-preview)', () => {
  const originalEnv = process.env;
  const mockSecret = 'test-match-secret-32-chars-length!';

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      RETURNING_MATCH_TOKEN_SECRET: mockSecret,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const req = new Request('http://localhost/api/passes/returning-id-preview?profileId=550e8400-e29b-41d4-a716-446655440000&requestId=550e8400-e29b-41d4-a716-446655440001&matchToken=valid-test-match-token-1234', {
      method: 'GET',
    });

    const res = await returningIdPreviewHandler.fetch(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('authentication_required');
  });

  it('rejects non-GET methods with 405', async () => {
    const req = new Request('http://localhost/api/passes/returning-id-preview', {
      method: 'POST',
    });

    const res = await returningIdPreviewHandler.fetch(req);
    expect(res.status).toBe(405);
  });

  it('rejects invalid query parameters with 400', async () => {
    const req = new Request('http://localhost/api/passes/returning-id-preview?profileId=not-a-uuid', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer valid.jwt.token',
      },
    });

    const res = await returningIdPreviewHandler.fetch(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
  });

  it('rejects non-anonymous or recovery sessions with 403', async () => {
    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: {} as any,
      anon: {} as any,
    });
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: 'user-staff-123' } as any,
      isAnonymous: false,
      isRecoverySession: false,
    });

    const req = new Request('http://localhost/api/passes/returning-id-preview?profileId=550e8400-e29b-41d4-a716-446655440000&requestId=550e8400-e29b-41d4-a716-446655440001&matchToken=valid-test-match-token-1234', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer staff.jwt.token',
      },
    });

    const res = await returningIdPreviewHandler.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('anonymous_visitor_required');
  });

  it('returns 503 if RETURNING_MATCH_TOKEN_SECRET is unconfigured', async () => {
    delete process.env.RETURNING_MATCH_TOKEN_SECRET;

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: {} as any,
      anon: {} as any,
    });
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: 'visitor-anon-123' } as any,
      isAnonymous: true,
      isRecoverySession: false,
    });

    const req = new Request('http://localhost/api/passes/returning-id-preview?profileId=550e8400-e29b-41d4-a716-446655440000&requestId=550e8400-e29b-41d4-a716-446655440001&matchToken=valid-test-match-token-1234', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer anon.jwt.token',
      },
    });

    const res = await returningIdPreviewHandler.fetch(req);
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('service_unavailable');
  });

  it('rejects when 1:1 biometric match attempt is not found or expired with 403', async () => {
    const mockAdmin = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'returning_identity_attempts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      }),
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      anon: {} as any,
    });
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: 'visitor-anon-123' } as any,
      isAnonymous: true,
      isRecoverySession: false,
    });

    const req = new Request('http://localhost/api/passes/returning-id-preview?profileId=550e8400-e29b-41d4-a716-446655440000&requestId=550e8400-e29b-41d4-a716-446655440001&matchToken=valid-test-match-token-1234', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer anon.jwt.token',
      },
    });

    const res = await returningIdPreviewHandler.fetch(req);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toBe('returning_match_required');
  });

  it('returns 404 when ID evidence is purged or missing', async () => {
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
                id: 'attempt-1',
                matched_profile_id: '550e8400-e29b-41d4-a716-446655440000',
                outcome: 'matched',
                expires_at: new Date(Date.now() + 600000).toISOString(),
              },
              error: null,
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
              data: {
                id: '550e8400-e29b-41d4-a716-446655440000',
                expires_at: new Date(Date.now() + 600000).toISOString(),
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
              data: null, // Purged or absent
              error: null,
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      }),
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      anon: {} as any,
    });
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: 'visitor-anon-123' } as any,
      isAnonymous: true,
      isRecoverySession: false,
    });

    const req = new Request('http://localhost/api/passes/returning-id-preview?profileId=550e8400-e29b-41d4-a716-446655440000&requestId=550e8400-e29b-41d4-a716-446655440001&matchToken=valid-test-match-token-1234', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer anon.jwt.token',
      },
    });

    const res = await returningIdPreviewHandler.fetch(req);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe('id_evidence_unavailable');
  });

  it('streams ID image with Cache-Control: private, no-store and Content-Type on successful verification', async () => {
    const mockImageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // Fake JPEG header
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
                id: 'attempt-1',
                matched_profile_id: '550e8400-e29b-41d4-a716-446655440000',
                outcome: 'matched',
                expires_at: new Date(Date.now() + 600000).toISOString(),
              },
              error: null,
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
              data: {
                id: '550e8400-e29b-41d4-a716-446655440000',
                expires_at: new Date(Date.now() + 600000).toISOString(),
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
                id: 'ev-id-1',
                bucket_id: 'visitor-ids',
                object_path: 'visitor-hist-1/id.jpg',
                content_type: 'image/jpeg',
                expires_at: new Date(Date.now() + 600000).toISOString(),
                purged_at: null,
              },
              error: null,
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({
            data: mockImageBytes,
            error: null,
          }),
        }),
      },
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      anon: {} as any,
    });
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      user: { id: 'visitor-anon-123' } as any,
      isAnonymous: true,
      isRecoverySession: false,
    });

    const req = new Request('http://localhost/api/passes/returning-id-preview?profileId=550e8400-e29b-41d4-a716-446655440000&requestId=550e8400-e29b-41d4-a716-446655440001&matchToken=valid-test-match-token-1234', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer anon.jwt.token',
      },
    });

    const res = await returningIdPreviewHandler.fetch(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/jpeg');
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes).toEqual(mockImageBytes);
  });
});
