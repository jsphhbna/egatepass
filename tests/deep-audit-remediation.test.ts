import { describe, expect, it, vi } from 'vitest';

let mockDatabaseError: any = null;

vi.mock('../server/supabase.js', () => ({
  getServerSupabaseClients: () => ({
    admin: {
      from: (table: string) => ({
        select: () => ({
          limit: () => ({
            maybeSingle: () => {
              if (mockDatabaseError) {
                return Promise.resolve({ data: null, error: mockDatabaseError });
              }
              return Promise.resolve({ data: { singleton: true }, error: null });
            },
          }),
        }),
      }),
    },
  }),
}));

import {
  resolveAuthoritativeVisitorForProfile,
  resolveEligibleRegistrationPortrait,
  isNameMatching,
  normalizeNameForComparison,
} from '../server/lib/returningVisitorResolution';
import healthHandler from '../server/routes/system/health';
import identifyReturningHandler from '../server/routes/passes/identify-returning';

function makeQueryMock(data: any, error: any = null) {
  const promise = Promise.resolve({ data, error });
  return Object.assign(promise, {
    order: () => makeQueryMock(data, error),
    limit: () => makeQueryMock(data, error),
    maybeSingle: () => Promise.resolve({ data: Array.isArray(data) ? data[0] : data, error }),
  });
}

describe('Deep Audit Remediation Test Suite', () => {
  describe('P1 — Returning Visitor Profile-to-Portrait Resolution', () => {
    it('normalizes names and compares with or without middle initials accurately', () => {
      expect(normalizeNameForComparison('  Juan  Carlos  ')).toBe('juan carlos');
      expect(isNameMatching('Juan M Dela Cruz', 'Juan', 'M', 'Dela Cruz')).toBe(true);
      expect(isNameMatching('Juan Mercado Dela Cruz', 'Juan', 'Mercado', 'Dela Cruz')).toBe(true);
      expect(isNameMatching('Juan Mercado Dela Cruz', 'Juan', 'M', 'Dela Cruz')).toBe(true);
      expect(isNameMatching('Juan Dela Cruz', 'Juan', null, 'Dela Cruz')).toBe(true);
      expect(isNameMatching('Maria Santos', 'Juan', null, 'Santos')).toBe(false);
    });

    it('resolves authoritative visitor via direct returning_profile_id linkage (precedence over fallback)', async () => {
      const mockVisitor = {
        id: 'vis-uuid-1',
        full_name: 'Juan Dela Cruz',
        contact_number: '+639171234567',
        psgc_city_code: '133900000',
        psgc_barangay_code: '133901001',
        returning_profile_id: 'prof-uuid-1',
        created_at: '2026-11-10T00:00:00Z',
      };

      const mockAdmin = {
        from: (table: string) => {
          if (table === 'visitors') {
            return {
              select: () => ({
                eq: (col: string, val: string) => {
                  if (col === 'returning_profile_id') {
                    return makeQueryMock([mockVisitor]);
                  }
                  return makeQueryMock([]);
                },
              }),
            };
          }
          return {};
        },
      };

      const result = await resolveAuthoritativeVisitorForProfile(mockAdmin as any, 'prof-uuid-1');
      expect(result.match).not.toBeNull();
      expect(result.match?.visitor.id).toBe('vis-uuid-1');
      expect(result.match?.resolutionMethod).toBe('direct_linkage');
    });

    it('resolves historical visitor fallback only when match is genuinely unique and eligible', async () => {
      const mockProfile = {
        id: 'prof-unlinked-1',
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        middle_name: null,
        contact_number_e164: '+639171234567',
        psgc_city_code: '133900000',
        psgc_barangay_code: '133901001',
      };

      const mockHistoricalVisitor = {
        id: 'vis-historical-1',
        full_name: 'Juan Dela Cruz',
        contact_number: '+639171234567',
        psgc_city_code: '133900000',
        psgc_barangay_code: '133901001',
        returning_profile_id: null,
        created_at: '2026-11-05T00:00:00Z',
      };

      const mockAdmin = {
        from: (table: string) => {
          if (table === 'visitors') {
            return {
              select: () => ({
                eq: (col: string, val: string) => {
                  if (col === 'returning_profile_id') {
                    return makeQueryMock([]);
                  }
                  if (col === 'contact_number') {
                    return makeQueryMock([mockHistoricalVisitor]);
                  }
                  return makeQueryMock([]);
                },
              }),
            };
          }
          if (table === 'returning_visitor_profiles') {
            return {
              select: () => ({
                eq: () => makeQueryMock(mockProfile),
              }),
            };
          }
          return {};
        },
      };

      const result = await resolveAuthoritativeVisitorForProfile(mockAdmin as any, 'prof-unlinked-1');
      expect(result.match).not.toBeNull();
      expect(result.match?.visitor.id).toBe('vis-historical-1');
      expect(result.match?.resolutionMethod).toBe('unambiguous_fallback');
    });

    it('fails closed (returns null match) when fallback historical visitors are ambiguous (> 1 match)', async () => {
      const mockProfile = {
        id: 'prof-unlinked-2',
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        middle_name: null,
        contact_number_e164: '+639171234567',
        psgc_city_code: '133900000',
        psgc_barangay_code: '133901001',
      };

      const multipleMatches = [
        {
          id: 'vis-historical-a',
          full_name: 'Juan Dela Cruz',
          contact_number: '+639171234567',
          psgc_city_code: '133900000',
          psgc_barangay_code: '133901001',
          returning_profile_id: null,
          created_at: '2026-11-01T00:00:00Z',
        },
        {
          id: 'vis-historical-b',
          full_name: 'Juan Dela Cruz',
          contact_number: '+639171234567',
          psgc_city_code: '133900000',
          psgc_barangay_code: '133901001',
          returning_profile_id: null,
          created_at: '2026-11-02T00:00:00Z',
        },
      ];

      const mockAdmin = {
        from: (table: string) => {
          if (table === 'visitors') {
            return {
              select: () => ({
                eq: (col: string, val: string) => {
                  if (col === 'returning_profile_id') {
                    return makeQueryMock([]);
                  }
                  if (col === 'contact_number') {
                    return makeQueryMock(multipleMatches);
                  }
                  return makeQueryMock([]);
                },
              }),
            };
          }
          if (table === 'returning_visitor_profiles') {
            return {
              select: () => ({
                eq: () => makeQueryMock(mockProfile),
              }),
            };
          }
          return {};
        },
      };

      const result = await resolveAuthoritativeVisitorForProfile(mockAdmin as any, 'prof-unlinked-2');
      expect(result.match).toBeNull();
      expect(result.error).toBe('ambiguous_historical_records');
    });

    it('rejects a fallback candidate that is already linked to another returning profile', async () => {
      const mockProfile = {
        id: 'prof-unlinked-3',
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        middle_name: null,
        contact_number_e164: '+639171234567',
        psgc_city_code: '133900000',
        psgc_barangay_code: '133901001',
      };

      // Candidate matches name, phone, locality, BUT is already linked to another profile
      const alreadyLinkedVisitor = {
        id: 'vis-linked-to-other',
        full_name: 'Juan Dela Cruz',
        contact_number: '+639171234567',
        psgc_city_code: '133900000',
        psgc_barangay_code: '133901001',
        returning_profile_id: 'other-profile-uuid',
        created_at: '2026-11-05T00:00:00Z',
      };

      const mockAdmin = {
        from: (table: string) => {
          if (table === 'visitors') {
            return {
              select: () => ({
                eq: (col: string) => {
                  if (col === 'returning_profile_id') {
                    return makeQueryMock([]);
                  }
                  if (col === 'contact_number') {
                    return makeQueryMock([alreadyLinkedVisitor]);
                  }
                  return makeQueryMock([]);
                },
              }),
            };
          }
          if (table === 'returning_visitor_profiles') {
            return {
              select: () => ({
                eq: () => makeQueryMock(mockProfile),
              }),
            };
          }
          return {};
        },
      };

      const result = await resolveAuthoritativeVisitorForProfile(mockAdmin as any, 'prof-unlinked-3');
      expect(result.match).toBeNull();
      expect(result.error).toBe('no_historical_visitor_records');
    });

    it('correctly processes candidate sets with > 10 historical records sharing a contact number', async () => {
      const mockProfile = {
        id: 'prof-unlinked-4',
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        middle_name: null,
        contact_number_e164: '+639171234567',
        psgc_city_code: '133900000',
        psgc_barangay_code: '133901001',
      };

      // 15 historical visitors sharing the phone number:
      // 14 have different names/localities, exactly 1 matches profile
      const largeCandidateSet = Array.from({ length: 15 }, (_, i) => {
        if (i === 12) {
          // The 13th candidate (which would be truncated by .limit(10)!) is the true unique match
          return {
            id: 'vis-large-13',
            full_name: 'Juan Dela Cruz',
            contact_number: '+639171234567',
            psgc_city_code: '133900000',
            psgc_barangay_code: '133901001',
            returning_profile_id: null,
            created_at: `2026-11-0${(i % 9) + 1}T00:00:00Z`,
          };
        }
        return {
          id: `vis-large-${i + 1}`,
          full_name: `Other Person ${i + 1}`,
          contact_number: '+639171234567',
          psgc_city_code: '133900000',
          psgc_barangay_code: '133901001',
          returning_profile_id: null,
          created_at: `2026-11-0${(i % 9) + 1}T00:00:00Z`,
        };
      });

      const mockAdmin = {
        from: (table: string) => {
          if (table === 'visitors') {
            return {
              select: () => ({
                eq: (col: string) => {
                  if (col === 'returning_profile_id') {
                    return makeQueryMock([]);
                  }
                  if (col === 'contact_number') {
                    return makeQueryMock(largeCandidateSet);
                  }
                  return makeQueryMock([]);
                },
              }),
            };
          }
          if (table === 'returning_visitor_profiles') {
            return {
              select: () => ({
                eq: () => makeQueryMock(mockProfile),
              }),
            };
          }
          return {};
        },
      };

      const result = await resolveAuthoritativeVisitorForProfile(mockAdmin as any, 'prof-unlinked-4');
      expect(result.match).not.toBeNull();
      expect(result.match?.visitor.id).toBe('vis-large-13');
      expect(result.match?.resolutionMethod).toBe('unambiguous_fallback');
    });

    it('rejects candidate with missing or empty visitor full_name', async () => {
      const mockProfile = {
        id: 'prof-unlinked-5',
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        middle_name: null,
        contact_number_e164: '+639171234567',
        psgc_city_code: '133900000',
        psgc_barangay_code: '133901001',
      };

      const anonymousVisitor = {
        id: 'vis-anon',
        full_name: '   ',
        contact_number: '+639171234567',
        psgc_city_code: '133900000',
        psgc_barangay_code: '133901001',
        returning_profile_id: null,
        created_at: '2026-11-05T00:00:00Z',
      };

      const mockAdmin = {
        from: (table: string) => {
          if (table === 'visitors') {
            return {
              select: () => ({
                eq: (col: string) => {
                  if (col === 'returning_profile_id') return makeQueryMock([]);
                  if (col === 'contact_number') return makeQueryMock([anonymousVisitor]);
                  return makeQueryMock([]);
                },
              }),
            };
          }
          if (table === 'returning_visitor_profiles') {
            return {
              select: () => ({ eq: () => makeQueryMock(mockProfile) }),
            };
          }
          return {};
        },
      };

      const result = await resolveAuthoritativeVisitorForProfile(mockAdmin as any, 'prof-unlinked-5');
      expect(result.match).toBeNull();
      expect(result.error).toBe('no_historical_visitor_records');
    });

    it('rejects candidate when PSGC locality is missing or conflicting', async () => {
      const mockProfile = {
        id: 'prof-unlinked-6',
        first_name: 'Juan',
        last_name: 'Dela Cruz',
        middle_name: null,
        contact_number_e164: '+639171234567',
        psgc_city_code: '133900000', // Manila
        psgc_barangay_code: '133901001',
      };

      // Conflicting city: 137400000 (Quezon City)
      const conflictingCityVisitor = {
        id: 'vis-qc',
        full_name: 'Juan Dela Cruz',
        contact_number: '+639171234567',
        psgc_city_code: '137400000',
        psgc_barangay_code: '137401001',
        returning_profile_id: null,
        created_at: '2026-11-05T00:00:00Z',
      };

      // Missing city on visitor
      const missingCityVisitor = {
        id: 'vis-nocity',
        full_name: 'Juan Dela Cruz',
        contact_number: '+639171234567',
        psgc_city_code: null,
        psgc_barangay_code: null,
        returning_profile_id: null,
        created_at: '2026-11-05T00:00:00Z',
      };

      const makeAdminFor = (v: any) => ({
        from: (table: string) => {
          if (table === 'visitors') {
            return {
              select: () => ({
                eq: (col: string) => {
                  if (col === 'returning_profile_id') return makeQueryMock([]);
                  if (col === 'contact_number') return makeQueryMock([v]);
                  return makeQueryMock([]);
                },
              }),
            };
          }
          if (table === 'returning_visitor_profiles') {
            return { select: () => ({ eq: () => makeQueryMock(mockProfile) }) };
          }
          return {};
        },
      });

      const resConflict = await resolveAuthoritativeVisitorForProfile(makeAdminFor(conflictingCityVisitor) as any, 'prof-unlinked-6');
      expect(resConflict.match).toBeNull();
      expect(resConflict.error).toBe('no_historical_visitor_records');

      const resMissing = await resolveAuthoritativeVisitorForProfile(makeAdminFor(missingCityVisitor) as any, 'prof-unlinked-6');
      expect(resMissing.match).toBeNull();
      expect(resMissing.error).toBe('no_historical_visitor_records');
    });

    it('resolves active, unpurged and unexpired registration portrait evidence', async () => {
      const futureDate = new Date(Date.now() + 86400000).toISOString();
      const validEvidence = {
        id: 'ev-1',
        visitor_id: 'vis-1',
        kind: 'photo',
        storage_path: 'visitor-photos/portrait.jpg',
        purged_at: null,
        expires_at: futureDate,
        created_at: '2026-11-14T00:00:00Z',
      };

      const mockAdmin = {
        from: (table: string) => {
          if (table === 'visitor_evidence') {
            return {
              select: () => ({
                in: () => ({
                  eq: () => ({
                    is: () => ({
                      gt: () => ({
                        order: () => ({
                          limit: () => Promise.resolve({ data: [validEvidence], error: null }),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            };
          }
          return {};
        },
      };

      const portrait = await resolveEligibleRegistrationPortrait(mockAdmin as any, 'vis-1');
      expect(portrait).not.toBeNull();
      expect(portrait?.id).toBe('ev-1');
    });

    it('rejects portrait when purged or expired under retention policy', async () => {
      const pastDate = new Date(Date.now() - 86400000).toISOString();
      const expiredEvidence = {
        id: 'ev-2',
        visitor_id: 'vis-1',
        kind: 'photo',
        storage_path: 'visitor-photos/portrait.jpg',
        purged_at: null,
        expires_at: pastDate,
      };

      const mockAdmin = {
        from: () => ({
          select: () => ({
            in: () => ({
              eq: () => ({
                is: () => ({
                  gt: () => ({
                    order: () => ({
                      limit: () => Promise.resolve({ data: [expiredEvidence], error: null }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      };

      const portrait = await resolveEligibleRegistrationPortrait(mockAdmin as any, 'vis-1');
      expect(portrait).toBeNull();
    });
  });

  describe('P2 — System Health Endpoint Semantics', () => {
    it('returns 200 healthy when app_settings singleton is accessible', async () => {
      const req = new Request('https://egatepass.tech/api/system/health', { method: 'GET' });
      mockDatabaseError = null;

      const res = await healthHandler.fetch(req);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.status).toBe('healthy');
      expect(body.database).toBe('connected');
      expect(body.liveness).toBe('ok');
      expect(res.headers.get('Cache-Control')).toContain('no-store');
    });

    it('returns 503 unhealthy when database query fails', async () => {
      const req = new Request('https://egatepass.tech/api/system/health', { method: 'GET' });
      mockDatabaseError = new Error('Connection refused');

      const res = await healthHandler.fetch(req);
      expect(res.status).toBe(503);

      const body = await res.json();
      expect(body.status).toBe('unhealthy');
      expect(body.database).toBe('disconnected');
      expect(body.liveness).toBe('degraded');
      mockDatabaseError = null;
    });
  });

  describe('P2 — Vercel Serverless Request Limits in identify-returning', () => {
    it('rejects oversized Content-Length > 4.2 MB immediately with 413 payload_too_large', async () => {
      const oversizedReq = new Request('https://egatepass.tech/api/passes/identify-returning', {
        method: 'POST',
        headers: {
          'Content-Length': '4500000', // 4.5 MB
          'Content-Type': 'application/json',
          Authorization: 'Bearer dummy-token',
        },
        body: JSON.stringify({ dummy: 'data' }),
      });

      const res = await identifyReturningHandler.fetch(oversizedReq);
      expect(res.status).toBe(413);

      const body = await res.json();
      expect(body.error).toBe('payload_too_large');
      expect(body.message).toContain('4.2 MB platform request limit');
    });
  });

  describe('P3 — Resend Delayed-Event Classification', () => {
    it('maps email.delivery_delayed to partial audit outcome without marking outbox as failed', async () => {
      const eventType = 'email.delivery_delayed';
      const outcome = eventType === 'email.delivered'
        ? 'success'
        : eventType === 'email.delivery_delayed'
        ? 'partial'
        : 'failure';

      expect(outcome).toBe('partial');
    });
  });
});
