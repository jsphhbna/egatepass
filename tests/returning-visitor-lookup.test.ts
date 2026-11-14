import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';
import lookupReturningHandler from '../server/routes/passes/lookup-returning.js';

describe('Returning Visitor 1:1 Profile Discovery & Masking Contract (lookup-returning)', () => {
  const originalEnv = { ...process.env };
  const actorId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      RETURNING_MATCH_TOKEN_SECRET: 'test-secret-at-least-32-characters-long!',
      RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-32-characters!',
      TURNSTILE_SECRET_KEY: 'test-turnstile-secret-at-least-32-chars!',
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: true, hostname: 'localhost' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('rejects non-POST requests with 405 Method Not Allowed', async () => {
    const req = new Request('http://localhost/api/passes/lookup-returning', {
      method: 'GET',
    });
    const res = await lookupReturningHandler.fetch(req);
    expect(res.status).toBe(405);
    const json = await res.json();
    expect(json.error).toBe('method_not_allowed');
  });

  it('rejects requests without Bearer token with 401 Authentication Required', async () => {
    const req = new Request('http://localhost/api/passes/lookup-returning', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ firstName: 'Juan', lastName: 'Cruz', contactNumber: '09171234567' }),
    });
    const res = await lookupReturningHandler.fetch(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error).toBe('authentication_required');
  });

  it('rejects requests with invalid payload with 400', async () => {
    const req = new Request('http://localhost/api/passes/lookup-returning', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ firstName: '', lastName: 'Cruz' }),
    });
    const res = await lookupReturningHandler.fetch(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });

  it('rejects authenticated non-anonymous sessions with 403', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      actorId,
      role: 'staff',
      isAnonymous: false,
      isRecoverySession: false,
      user: { id: actorId },
      identity: 'staff-user',
      email: 'staff@example.com',
    } as any);

    const mockAdmin = {
      schema: vi.fn(),
      from: vi.fn(),
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
      body: JSON.stringify({ firstName: 'Juan', lastName: 'Cruz', contactNumber: '09171234567', captchaToken: 'cf-turnstile-429-test' }),
    });

    const res = await lookupReturningHandler.fetch(req);
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error).toBe('anonymous_visitor_required');
  });

  it('enforces rate limiting when actor limit is exceeded (429)', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      actorId,
      role: 'visitor',
      isAnonymous: true,
      isRecoverySession: false,
      user: { id: actorId },
      identity: 'test-user',
    } as any);

    const mockAdmin = {
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({ data: false, error: null }),
      }),
      from: vi.fn(),
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
      body: JSON.stringify({ firstName: 'Juan', lastName: 'Cruz', contactNumber: '09171234567', captchaToken: 'cf-turnstile-429-test' }),
    });

    const res = await lookupReturningHandler.fetch(req);
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error).toBe('rate_limit_exceeded');
  });

  it('returns masked profile candidate records without leaking full plaintext PII', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      actorId,
      role: 'visitor',
      isAnonymous: true,
      isRecoverySession: false,
      user: { id: actorId },
      identity: 'test-user',
    } as any);

    const candidateProfile = {
      id: '55555555-5555-4555-8555-555555555555',
      first_name: 'Juan',
      middle_name: 'Dela',
      last_name: 'Cruz',
      contact_number_e164: '+639171234567',
      psgc_barangay_name: 'Barangay 408',
      psgc_city_municipality_name: 'City of Manila',
      psgc_province_name: null,
      psgc_region_name: 'National Capital Region',
    };

    const mockAdmin = {
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      }),
      from: vi.fn((table: string) => {
        if (table === 'returning_visitor_profiles') {
          return {
            select: vi.fn().mockReturnThis(),
            ilike: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [candidateProfile],
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

    const req = new Request('http://localhost/api/passes/lookup-returning', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        firstName: 'Juan',
        lastName: 'Cruz',
        middleName: 'Dela',
        contactNumber: '09171234567',
        captchaToken: 'cf-turnstile-masked-test',
      }),
    });

    const res = await lookupReturningHandler.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.candidates).toHaveLength(1);

    const candidate = json.candidates[0];
    expect(candidate.profileId).toBe('55555555-5555-4555-8555-555555555555');
    // Name is masked
    expect(candidate.maskedName).toBe('Juan D. C***');
    // Contact is masked
    expect(candidate.maskedContact).toBe('+639***4567');
    // Locality is partial
    expect(candidate.partialLocality).toBe('Barangay 408, City of Manila');
  });

  it('rejects wildcard characters (% and _) in name search with 400', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      actorId,
      role: 'visitor',
      isAnonymous: true,
      isRecoverySession: false,
      user: { id: actorId },
      identity: 'test-user',
    } as any);

    const req = new Request('http://localhost/api/passes/lookup-returning', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        firstName: 'Ju%',
        lastName: 'Cr_z',
        contactNumber: '09171234567',
      }),
    });

    const res = await lookupReturningHandler.fetch(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });

  it('rejects lookup without contactNumber or psgcCityCode with 400', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      actorId,
      role: 'visitor',
      isAnonymous: true,
      isRecoverySession: false,
      user: { id: actorId },
      identity: 'test-user',
    } as any);

    const req = new Request('http://localhost/api/passes/lookup-returning', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        firstName: 'Juan',
        lastName: 'Cruz',
      }),
    });

    const res = await lookupReturningHandler.fetch(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe('invalid_request');
  });

  it('returns empty candidates array when no profiles match', async () => {
    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      actorId,
      role: 'visitor',
      isAnonymous: true,
      isRecoverySession: false,
      user: { id: actorId },
      identity: 'test-user',
    } as any);

    const mockAdmin = {
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      }),
      from: vi.fn((table: string) => {
        if (table === 'returning_visitor_profiles') {
          return {
            select: vi.fn().mockReturnThis(),
            ilike: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [],
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

    const req = new Request('http://localhost/api/passes/lookup-returning', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        firstName: 'Nonexistent',
        lastName: 'Person',
        contactNumber: '09171234567',
        captchaToken: 'cf-turnstile-empty-test',
      }),
    });

    const res = await lookupReturningHandler.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.candidates).toEqual([]);
  });

  it('succeeds without requiring TURNSTILE_SECRET_KEY in Vercel environment', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;

    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      actorId,
      role: 'visitor',
      isAnonymous: true,
      isRecoverySession: false,
      user: { id: actorId },
      identity: 'test-user',
    } as any);

    const mockAdmin = {
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockResolvedValue({ data: true, error: null }),
      }),
      from: vi.fn((table: string) => {
        if (table === 'returning_visitor_profiles') {
          return {
            select: vi.fn().mockReturnThis(),
            ilike: vi.fn().mockReturnThis(),
            gt: vi.fn().mockReturnThis(),
            is: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'a1111111-1111-4111-8111-111111111111',
                  first_name: 'Juan',
                  middle_name: null,
                  last_name: 'Cruz',
                  contact_number_e164: '+639171234567',
                  psgc_city_code: '1381300000',
                  psgc_barangay_code: '1381300005',
                  psgc_city_municipality_name: 'Quezon City',
                  psgc_barangay_name: 'Baesa',
                  psgc_province_name: null,
                  psgc_region_name: 'NCR',
                  created_at: new Date().toISOString(),
                },
              ],
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

    const req = new Request('http://localhost/api/passes/lookup-returning', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        firstName: 'Juan',
        lastName: 'Cruz',
        contactNumber: '09171234567',
      }),
    });

    const res = await lookupReturningHandler.fetch(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.found).toBe(true);
    expect(json.candidates.length).toBe(1);
    expect(json.candidates[0].profileId).toBe('a1111111-1111-4111-8111-111111111111');
  });
});
