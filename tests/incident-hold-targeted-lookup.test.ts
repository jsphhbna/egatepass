import { describe, it, expect, vi, beforeEach } from 'vitest';
import holdsHandler from '../server/routes/admin/holds.js';
import { setServerSupabaseClientsForTest } from '../server/supabase.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ADMIN_ID = '00000000-0000-4000-a000-000000000001';
const SUPERADMIN_ID = '00000000-0000-4000-a000-000000000002';

const VALID_BEARER = `Bearer ${Buffer.from(
  JSON.stringify({
    sub: ADMIN_ID,
    role: 'authenticated',
    aud: 'authenticated',
    email: 'admin@earist.edu.ph',
    exp: Math.floor(Date.now() / 1000) + 3600,
    amr: [{ method: 'password' }],
  }),
).toString('base64')}`;

describe('PATCH 5: Authoritative Incident-Hold Targeted Lookup Tests', () => {
  const TARGET_PASS_ID = '00000000-0000-4000-b000-000000000010';
  const TARGET_VISITOR_ID = '00000000-0000-4000-a000-000000000020';

  function createMockSupabase(allHolds: any[]) {
    return {
      from: vi.fn((table: string) => ({
        select: vi.fn((_columns?: string) => {
          let filtered = [...allHolds];
          const queryBuilder: any = {
            order: vi.fn((col: string, { ascending }: { ascending: boolean }) => {
              filtered.sort((a, b) => (ascending ? a[col] - b[col] : b[col] - a[col]));
              return queryBuilder;
            }),
            limit: vi.fn((n: number) => {
              filtered = filtered.slice(0, n);
              return Promise.resolve({ data: filtered, error: null });
            }),
            eq: vi.fn((col: string, val: any) => {
              filtered = filtered.filter((h) => h[col] === val);
              return queryBuilder;
            }),
            or: vi.fn((orExpr: string) => {
              // Parses e.g. "pass_id.eq.<uuid>,visitor_id.eq.<uuid>"
              const parts = orExpr.split(',').map((p) => {
                const [field, , value] = p.split('.');
                return { field, value };
              });
              filtered = filtered.filter((h) =>
                parts.some((p) => h[p.field] === p.value),
              );
              return queryBuilder;
            }),
            then: (resolve: any) => resolve({ data: filtered, error: null }),
          };
          return queryBuilder;
        }),
      })),
      auth: {
        getUser: vi.fn(async () => ({
          data: {
            user: {
              id: ADMIN_ID,
              email: 'admin@earist.edu.ph',
              is_anonymous: false,
              email_confirmed_at: '2026-01-01T00:00:00Z',
            },
          },
          error: null,
        })),
      },
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('5A. Validates UUIDs with Zod (invalid UUID in passId or visitorId returns 400)', async () => {
    const mockAdmin = createMockSupabase([]);
    mockAdmin.from = vi.fn((table: string) => {
      if (table === 'staff_profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: {
                  role: 'admin',
                  active: true,
                  must_change_password: false,
                  privacy_accepted_at: '2026-01-01T00:00:00Z',
                },
                error: null,
              })),
            })),
          })),
        } as any;
      }
      return { select: vi.fn() } as any;
    });

    setServerSupabaseClientsForTest({
      admin: mockAdmin as any,
      anon: {} as any,
      passwordVerifier: {} as any,
    });

    const badPassReq = new Request('http://localhost/api/admin/holds?passId=not-a-uuid', {
      headers: { authorization: VALID_BEARER },
    });
    const badPassRes = await holdsHandler.fetch(badPassReq);
    expect(badPassRes.status).toBe(400);

    const badVisReq = new Request('http://localhost/api/admin/holds?visitorId=invalid-uuid', {
      headers: { authorization: VALID_BEARER },
    });
    const badVisRes = await holdsHandler.fetch(badVisReq);
    expect(badVisRes.status).toBe(400);
  });

  it('5A. 101 active global holds: targeted lookup finds hold outside top 100 global records', async () => {
    // Generate 100 unrelated active holds created today
    const global100: any[] = [];
    for (let i = 1; i <= 100; i++) {
      global100.push({
        id: `00000000-0000-4000-e000-${String(i).padStart(12, '0')}`,
        visitor_id: `00000000-0000-4000-f000-${String(i).padStart(12, '0')}`,
        pass_id: `00000000-0000-4000-d000-${String(i).padStart(12, '0')}`,
        reason: `Global hold ${i}`,
        active: true,
        created_by: SUPERADMIN_ID,
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      });
    }

    // The target hold was created earlier (older than top 100 global holds)
    const targetHold = {
      id: '00000000-0000-4000-a000-000000000999',
      visitor_id: TARGET_VISITOR_ID,
      pass_id: TARGET_PASS_ID,
      reason: 'Target investigation hold',
      active: true,
      created_by: SUPERADMIN_ID,
      created_at: new Date(Date.now() - 200000).toISOString(),
    };

    // Total 101 holds in table
    const allTableHolds = [...global100, targetHold];

    // If an old naive list was used (limit: 100 without filter):
    const naiveGlobal100 = [...allTableHolds].slice(0, 100);
    expect(naiveGlobal100.find((h) => h.pass_id === TARGET_PASS_ID)).toBeUndefined();

    // Now test targeted backend query
    const mockAdmin = createMockSupabase(allTableHolds);
    mockAdmin.from = vi.fn((table: string) => {
      if (table === 'staff_profiles') {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: {
                  role: 'admin',
                  active: true,
                  must_change_password: false,
                  privacy_accepted_at: '2026-01-01T00:00:00Z',
                },
                error: null,
              })),
            })),
          })),
        } as any;
      }
      if (table === 'incident_holds') {
        let filtered = [...allTableHolds];
        const queryBuilder: any = {
          eq: vi.fn((col: string, val: any) => {
            filtered = filtered.filter((h) => h[col] === val);
            return queryBuilder;
          }),
          or: vi.fn((expr: string) => {
            filtered = filtered.filter(
              (h) => h.pass_id === TARGET_PASS_ID || h.visitor_id === TARGET_VISITOR_ID,
            );
            return queryBuilder;
          }),
          order: vi.fn(() => queryBuilder),
          limit: vi.fn((n: number) => {
            filtered = filtered.slice(0, n);
            return Promise.resolve({ data: filtered, error: null });
          }),
        };
        return { select: vi.fn(() => queryBuilder) };
      }
      return { select: vi.fn() } as any;
    });

    setServerSupabaseClientsForTest({
      admin: mockAdmin as any,
      anon: {} as any,
      passwordVerifier: {} as any,
    });

    const targetedReq = new Request(
      `http://localhost/api/admin/holds?active=true&passId=${TARGET_PASS_ID}&visitorId=${TARGET_VISITOR_ID}`,
      { headers: { authorization: VALID_BEARER } },
    );

    const res = await holdsHandler.fetch(targetedReq);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.holds).toHaveLength(1);
    expect(body.holds[0].id).toBe(targetHold.id);
    expect(body.holds[0].reason).toBe('Target investigation hold');
  });

  it('5A. Deterministic sorting: direct pass hold first, then visitor-level hold, then newest created_at', async () => {
    const olderPassHold = {
      id: '00000000-0000-4000-a000-000000000001',
      visitor_id: TARGET_VISITOR_ID,
      pass_id: TARGET_PASS_ID,
      reason: 'Direct pass hold older',
      active: true,
      created_by: SUPERADMIN_ID,
      created_at: '2026-10-20T10:00:00Z',
    };
    const newerPassHold = {
      id: '00000000-0000-4000-a000-000000000002',
      visitor_id: TARGET_VISITOR_ID,
      pass_id: TARGET_PASS_ID,
      reason: 'Direct pass hold newer',
      active: true,
      created_by: SUPERADMIN_ID,
      created_at: '2026-10-21T10:00:00Z',
    };
    const visitorLevelHold = {
      id: '00000000-0000-4000-a000-000000000003',
      visitor_id: TARGET_VISITOR_ID,
      pass_id: null,
      reason: 'Visitor-level hold',
      active: true,
      created_by: SUPERADMIN_ID,
      created_at: '2026-10-22T10:00:00Z', // Newer timestamp than pass holds
    };

    const holdsList = [visitorLevelHold, olderPassHold, newerPassHold];

    const mockAdmin = {
      from: vi.fn((table: string) => {
        if (table === 'staff_profiles') {
          return {
            select: vi.fn(() => ({
              eq: vi.fn(() => ({
                maybeSingle: vi.fn(async () => ({
                  data: {
                    role: 'admin',
                    active: true,
                    must_change_password: false,
                    privacy_accepted_at: '2026-01-01T00:00:00Z',
                  },
                  error: null,
                })),
              })),
            })),
          };
        }
        if (table === 'incident_holds') {
          return {
            select: vi.fn(() => ({
              or: vi.fn(() => ({
                eq: vi.fn(() => ({
                  limit: vi.fn(async () => ({ data: holdsList, error: null })),
                })),
              })),
            })),
          };
        }
        return { select: vi.fn() };
      }),
      auth: {
        getUser: vi.fn(async () => ({
          data: {
            user: {
              id: ADMIN_ID,
              email: 'admin@earist.edu.ph',
              is_anonymous: false,
              email_confirmed_at: '2026-01-01T00:00:00Z',
            },
          },
          error: null,
        })),
      },
    };

    setServerSupabaseClientsForTest({
      admin: mockAdmin as any,
      anon: {} as any,
      passwordVerifier: {} as any,
    });

    const req = new Request(
      `http://localhost/api/admin/holds?active=true&passId=${TARGET_PASS_ID}&visitorId=${TARGET_VISITOR_ID}`,
      { headers: { authorization: VALID_BEARER } },
    );
    const res = await holdsHandler.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Sorting must be:
    // 1. Direct pass hold newer (2026-10-21)
    // 2. Direct pass hold older (2026-10-20)
    // 3. Visitor-level hold (2026-10-22)
    expect(body.holds).toHaveLength(3);
    expect(body.holds[0].id).toBe(newerPassHold.id);
    expect(body.holds[1].id).toBe(olderPassHold.id);
    expect(body.holds[2].id).toBe(visitorLevelHold.id);
  });

  it('5B. incidentHold.ts exports getActiveIncidentHoldsForRecord using targeted query params', () => {
    const serviceCode = readFileSync(
      join(process.cwd(), 'src', 'services', 'incidentHold.ts'),
      'utf8',
    );
    expect(serviceCode).toContain('export async function getActiveIncidentHoldsForRecord');
    expect(serviceCode).toContain("url.searchParams.set('active', 'true')");
    expect(serviceCode).toContain("url.searchParams.set('passId', params.passId)");
    expect(serviceCode).toContain("url.searchParams.set('visitorId', params.visitorId)");
  });

  it('5C & 5D. AdminRecords.tsx enforces explicit HoldLookupState and protects against false-negative retention', () => {
    const adminRecordsCode = readFileSync(
      join(process.cwd(), 'src', 'pages', 'AdminRecords.tsx'),
      'utf8',
    );

    // Explicit state type
    expect(adminRecordsCode).toContain("type HoldLookupState =");
    expect(adminRecordsCode).toMatch(/\{\s*status:\s*'loading'/);
    expect(adminRecordsCode).toMatch(/\{\s*status:\s*'protected'/);
    expect(adminRecordsCode).toMatch(/\{\s*status:\s*'unprotected'/);
    expect(adminRecordsCode).toMatch(/\{\s*status:\s*'error'/);

    // UI text requirements
    expect(adminRecordsCode).toContain('Checking retention protection…');
    expect(adminRecordsCode).toContain('Active Incident Hold');
    expect(adminRecordsCode).toContain('Normal Retention');
    expect(adminRecordsCode).toContain('Retention protection status unavailable.');
    expect(adminRecordsCode).toContain('Do not assume this record is unprotected.');

    // 5D: Disables unsafe hold creation during loading or error
    expect(adminRecordsCode).toContain(
      "disabled={holdLookupState.status === 'loading' || holdLookupState.status === 'error'}",
    );
    expect(adminRecordsCode).toContain(
      "if (holdLookupState.status === 'loading' || holdLookupState.status === 'error')",
    );
  });
});
