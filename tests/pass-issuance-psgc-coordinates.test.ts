import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';
import passIssueHandler from '../server/routes/passes/issue.js';

describe('Pass Issuance PSGC Address & Coordinate Strictness Invariants', () => {
  const actorId = '33333333-3333-4333-8333-333333333333';
  const requestId = '44444444-4444-4444-8444-444444444444';
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      PASS_TOKEN_SECRET: 'test-pass-token-secret-at-least-32-chars-long!',
      RATE_LIMIT_HMAC_SECRET: 'test-rate-limit-secret-32-chars-long!',
      RETURNING_MATCH_TOKEN_SECRET: 'test-returning-secret-32-chars-long!',
    };

    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      actorId,
      role: 'visitor',
      isAnonymous: true,
      isRecoverySession: false,
      user: { id: actorId },
      identity: 'test-visitor',
    } as any);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('strictly rejects portal pass issuance when map coordinates are supplied without PSGC address (422 psgc_address_required)', async () => {
    const mockAdmin = {
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockImplementation((name: string) => {
          if (name === 'consume_rate_limit') {
            return Promise.resolve({ data: true, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        }),
      }),
      from: vi.fn((table: string) => {
        if (table === 'passes') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      client: {} as any,
      passwordVerifier: {} as any,
    });

    const payload = {
      requestId,
      source: 'portal',
      registrationMode: 'new',
      visitor: {
        firstName: 'Juan',
        lastName: 'Dela Cruz',
        contactNumber: '09171234567',
        purpose: 'Official Campus Inquiry',
        visitDate: '2026-11-20',
      },
      arrivalMode: 'no_vehicle',
      // User pinned Cebu on the map, but omitted PSGC cascading dropdowns
      homeLocation: {
        lat: 10.3157,
        lon: 123.8854,
      },
      // psgc omitted
      photoIntentId: '55555555-5555-4555-8555-555555555555',
      idIntentId: '66666666-6666-4666-8666-666666666666',
    };

    const req = new Request('http://localhost/api/passes/issue', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const res = await passIssueHandler.fetch(req);
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('psgc_address_required');
    expect(json.message).toContain('complete structured Philippine address');
  });

  it('does NOT silently substitute Manila Barangay 410 when complete PSGC address is provided', async () => {
    let capturedRpcArgs: Record<string, unknown> | null = null;

    const mockAdmin = {
      schema: vi.fn().mockReturnValue({
        rpc: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
          if (name === 'consume_rate_limit') {
            return Promise.resolve({ data: true, error: null });
          }
          if (name === 'issue_online_pass_v6') {
            capturedRpcArgs = args;
            return {
              single: vi.fn().mockResolvedValue({
                data: {
                  pass_id: 'pass-uuid-1',
                  public_reference: 'pub-ref-1',
                  valid_from: '2026-11-20T08:00:00Z',
                  valid_until: '2026-11-20T17:00:00Z',
                },
                error: null,
              }),
            };
          }
          return Promise.resolve({ data: null, error: null });
        }),
      }),
      from: vi.fn((table: string) => {
        if (table === 'passes') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }
        if (table === 'portal_identity_verification_attempts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                id: 'attempt-uuid',
                outcome: 'matched',
                expires_at: new Date(Date.now() + 600000).toISOString(),
              },
              error: null,
            }),
          };
        }
        if (table === 'upload_intents') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn((col: string, val: string) => {
              const intentKind = val === '66666666-6666-4666-8666-666666666666' ? 'id' : 'photo';
              return {
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: val,
                    owner_id: actorId,
                    source: 'portal',
                    kind: intentKind,
                    bucket_id: 'visitor-evidence',
                    object_path: `${intentKind}.jpg`,
                    content_type: 'image/jpeg',
                    max_bytes: 5000000,
                    status: 'pending',
                    expires_at: new Date(Date.now() + 600000).toISOString(),
                  },
                  error: null,
                }),
              };
            }),
          };
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
        };
      }),
      storage: {
        from: vi.fn().mockReturnValue({
          download: vi.fn().mockResolvedValue({
            data: {
              arrayBuffer: () => Promise.resolve(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]).buffer),
            },
            error: null,
          }),
        }),
      },
    };

    vi.spyOn(supabaseModule, 'getServerSupabaseClients').mockReturnValue({
      admin: mockAdmin as any,
      client: {} as any,
      passwordVerifier: {} as any,
    });

    const payload = {
      requestId,
      source: 'portal',
      registrationMode: 'new',
      visitor: {
        firstName: 'Maria',
        lastName: 'Santos',
        contactNumber: '09179998888',
        purpose: 'Admissions Inquiry',
        visitDate: '2026-11-20',
      },
      arrivalMode: 'no_vehicle',
      // Batangas City, Batangas, Region IV-A
      psgc: {
        version: '2026-q3',
        regionCode: '0400000000',
        provinceCode: '0410000000',
        cityCode: '0410050000',
        barangayCode: '0410050001',
        houseBuilding: 'Block 1 Lot 2',
        street: 'Rizal Avenue',
      },
      photoIntentId: '55555555-5555-4555-8555-555555555555',
      idIntentId: '66666666-6666-4666-8666-666666666666',
    };

    const req = new Request('http://localhost/api/passes/issue', {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const res = await passIssueHandler.fetch(req);
    expect(res.status).toBe(201);
    expect(capturedRpcArgs).not.toBeNull();
    // Verify exact PSGC codes were passed to RPC, NEVER defaulting to Manila 1300000000 / 1380606014
    expect(capturedRpcArgs!.requested_psgc_region_code).toBe('0400000000');
    expect(capturedRpcArgs!.requested_psgc_province_code).toBe('0410000000');
    expect(capturedRpcArgs!.requested_psgc_city_code).toBe('0410050000');
    expect(capturedRpcArgs!.requested_psgc_barangay_code).toBe('0410050001');
  });
});
