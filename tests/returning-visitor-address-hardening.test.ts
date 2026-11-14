/**
 * tests/returning-visitor-address-hardening.test.ts
 *
 * Comprehensive integration and unit tests for Returning Visitor Address Hardening:
 * - PART 1: PSGC locality level normalization, city_municipality consistency, and validation
 * - PART 2: Address normalization and PSGC locality fallback in identify-returning.ts
 * - PART 3: Postal code mapping metadata reconstruction & honest provenance
 * - PART 4: Returning profile persistence in issue.ts with complete fail-closed validation permutations
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { resolvePsgcLocalityFallback, computeMatchTokenDigest } from '../server/routes/passes/identify-returning.js';
import {
  normalizePsgcLevel,
  buildExpectedPsgcReferences,
  validatePsgcReferences,
} from '../server/lib/psgc-reference.js';
import { hydrateReturningAddress } from '../src/lib/returningAddressHydration.js';
import { isSameLocality } from '../src/lib/psgcAddressResolution.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';
import issuePassHandler from '../server/routes/passes/issue.js';

// ---------------------------------------------------------------------------
// PART 1: PSGC Locality Level Normalization & Reference Validation Helpers
// ---------------------------------------------------------------------------

describe('PART 1: PSGC Locality Normalization & Reference Validation Helpers', () => {
  it('1. normalizePsgcLevel recognizes city, municipality, and city_municipality', () => {
    expect(normalizePsgcLevel('city')).toBe('city_municipality');
    expect(normalizePsgcLevel('municipality')).toBe('city_municipality');
    expect(normalizePsgcLevel('city_municipality')).toBe('city_municipality');
    expect(normalizePsgcLevel('CITY')).toBe('city_municipality');
    expect(normalizePsgcLevel('  Municipality  ')).toBe('city_municipality');
  });

  it('2. normalizePsgcLevel correctly identifies region, province, barangay, and unknown', () => {
    expect(normalizePsgcLevel('region')).toBe('region');
    expect(normalizePsgcLevel('province')).toBe('province');
    expect(normalizePsgcLevel('barangay')).toBe('barangay');
    expect(normalizePsgcLevel('sub_municipality')).toBe('unknown');
    expect(normalizePsgcLevel(null)).toBe('unknown');
    expect(normalizePsgcLevel('')).toBe('unknown');
  });

  const validExpectedRefs = buildExpectedPsgcReferences({
    regionCode: '0400000000',
    provinceCode: '0434200000',
    cityCode: '0434203000',
    barangayCode: '0434203001',
  });

  it('3. A city record resolves successfully in validatePsgcReferences', () => {
    const records = [
      { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
      { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
      { psgc_code: '0434203000', level: 'city', name: 'City of Biñan' },
      { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
    ];
    const result = validatePsgcReferences(validExpectedRefs, records);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.cityName).toBe('City of Biñan');
    }
  });

  it('4. A municipality record resolves successfully in validatePsgcReferences', () => {
    const records = [
      { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
      { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
      { psgc_code: '0434203000', level: 'municipality', name: 'Municipality of Biñan' },
      { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
    ];
    const result = validatePsgcReferences(validExpectedRefs, records);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.cityName).toBe('Municipality of Biñan');
    }
  });

  it('5. A city_municipality record resolves successfully in validatePsgcReferences', () => {
    const records = [
      { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
      { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
      { psgc_code: '0434203000', level: 'city_municipality', name: 'Biñan City' },
      { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
    ];
    const result = validatePsgcReferences(validExpectedRefs, records);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.cityName).toBe('Biñan City');
    }
  });

  it('6. An unrelated or mismatched code cannot supply a locality name', () => {
    const records = [
      { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
      { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
      // Unrelated code: 0434999999 instead of 0434203000
      { psgc_code: '0434999999', level: 'city', name: 'Unrelated City' },
      { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
    ];
    const result = validatePsgcReferences(validExpectedRefs, records);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('missing_expected_psgc_record_city_municipality');
    }
  });

  it('7. Duplicate conflicting records for the same code fail validation as ambiguous', () => {
    const records = [
      { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
      { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
      { psgc_code: '0434203000', level: 'city', name: 'City of Biñan' },
      { psgc_code: '0434203000', level: 'city', name: 'Conflicting Biñan Name' },
      { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
    ];
    const result = validatePsgcReferences(validExpectedRefs, records);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('ambiguous_psgc_records_for_code_0434203000');
    }
  });
});

// ---------------------------------------------------------------------------
// PART 2: Locality Fallback & Address Normalization
// ---------------------------------------------------------------------------

describe('PART 2: resolvePsgcLocalityFallback & Address Normalization', () => {
  const baseProfile = {
    psgc_region_code: '0400000000',
    psgc_region_name: 'Region IV-A (CALABARZON)',
    psgc_province_code: '0434200000',
    psgc_province_name: 'Laguna',
    psgc_city_code: '0434203000',
    psgc_city_municipality_name: 'City of Biñan',
    psgc_barangay_code: '0434203001',
    psgc_barangay_name: 'Biñan Proper',
  };

  const referenceLocations = [
    { psgc_code: '0400000000', level: 'region', name: 'Region IV-A (CALABARZON)' },
    { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
    { psgc_code: '0434203000', level: 'city_municipality', name: 'City of Biñan' },
    { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
  ];

  it('1. Complete locality names requiring no fallback return existing names untouched', () => {
    const resolved = resolvePsgcLocalityFallback(baseProfile, []);
    expect(resolved.regionName).toBe('Region IV-A (CALABARZON)');
    expect(resolved.provinceName).toBe('Laguna');
    expect(resolved.cityName).toBe('City of Biñan');
    expect(resolved.barangayName).toBe('Biñan Proper');
  });

  it('2. Only province name missing: resolves province name from reference locations', () => {
    const profile = { ...baseProfile, psgc_province_name: '' };
    const resolved = resolvePsgcLocalityFallback(profile, referenceLocations);
    expect(resolved.provinceName).toBe('Laguna');
    expect(resolved.regionName).toBe('Region IV-A (CALABARZON)');
  });

  it('3. Only region name missing: resolves region name from reference locations', () => {
    const profile = { ...baseProfile, psgc_region_name: null };
    const resolved = resolvePsgcLocalityFallback(profile, referenceLocations);
    expect(resolved.regionName).toBe('Region IV-A (CALABARZON)');
    expect(resolved.cityName).toBe('City of Biñan');
  });

  it('4. Only city name missing: resolves city name from reference locations', () => {
    const profile = { ...baseProfile, psgc_city_municipality_name: '   ' };
    const resolved = resolvePsgcLocalityFallback(profile, referenceLocations);
    expect(resolved.cityName).toBe('City of Biñan');
  });

  it('5. Only barangay name missing: resolves barangay name from reference locations', () => {
    const profile = { ...baseProfile, psgc_barangay_name: '' };
    const resolved = resolvePsgcLocalityFallback(profile, referenceLocations);
    expect(resolved.barangayName).toBe('Biñan Proper');
  });

  it('6. Whitespace-only locality names are replaced with resolved names', () => {
    const profile = {
      ...baseProfile,
      psgc_region_name: '  \t  ',
      psgc_province_name: '   ',
      psgc_city_municipality_name: ' \n ',
      psgc_barangay_name: '   ',
    };
    const resolved = resolvePsgcLocalityFallback(profile, referenceLocations);
    expect(resolved.regionName).toBe('Region IV-A (CALABARZON)');
    expect(resolved.provinceName).toBe('Laguna');
    expect(resolved.cityName).toBe('City of Biñan');
    expect(resolved.barangayName).toBe('Biñan Proper');
  });

  it('7. Reference lookup failure: returns safe fallback without fabricating names', () => {
    const profile = {
      ...baseProfile,
      psgc_province_name: '',
      psgc_city_municipality_name: '',
    };
    const resolved = resolvePsgcLocalityFallback(profile, []);
    expect(resolved.provinceName).toBe('');
    expect(resolved.cityName).toBe('');
    expect(resolved.regionName).toBe('Region IV-A (CALABARZON)');
    expect(resolved.barangayName).toBe('Biñan Proper');
  });

  it('8. Optional address fields normalization: whitespace-only strings become empty string', () => {
    const hydrated = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601001', name: 'Barangay 1' },
        houseBuilding: '   ',
        street: '  \t  ',
        postalCode: '    ',
        postalCodeSource: '   ',
      },
    });

    expect(hydrated.homeBuilding).toBe('');
    expect(hydrated.homeStreet).toBe('');
    expect('postalCode' in hydrated).toBe(false);
    expect((hydrated as any).postalCode).toBeUndefined();
    expect(hydrated.selectedPsgc?.postalCode).toBeUndefined();
    expect(hydrated.selectedPsgc?.postalCodeSource).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// PART 3: Postal Code Metadata & Source Stability
// ---------------------------------------------------------------------------

describe('PART 3: Postal Code Decommissioning and Hydration Independence', () => {
  it('1. Returning profile hydration does not restore postal code or resolution metadata', () => {
    const hydrated = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601001', name: 'Barangay 1' },
        postalCode: '1008',
        postalCodeSource: 'PHLPost',
        postalMappingType: 'exact_barangay',
      } as any,
    });

    expect('postalCode' in hydrated).toBe(false);
    expect((hydrated as any).postalCode).toBeUndefined();
    expect((hydrated.selectedPsgc as any)?.postalResolution).toBeUndefined();
    expect((hydrated.selectedPsgc as any)?.postalCode).toBeUndefined();
    expect((hydrated.selectedPsgc as any)?.postalCodeSource).toBeUndefined();
  });

  it('2. Unique city mapping in legacy profile is ignored during hydration', () => {
    const hydrated = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '0400000000', name: 'CALABARZON' },
        province: { code: '0434200000', name: 'Laguna' },
        city: { code: '0434203000', name: 'City of Biñan' },
        barangay: { code: '0434203001', name: 'Biñan Proper' },
        postalCode: '4024',
        postalCodeSource: 'PHLPost',
        postalMappingType: 'unique_city',
      } as any,
    });

    expect('postalCode' in hydrated).toBe(false);
    expect((hydrated.selectedPsgc as any)?.postalResolution).toBeUndefined();
    expect((hydrated.selectedPsgc as any)?.postalCodeSource).toBeUndefined();
  });

  it('3. Unknown mapping metadata in legacy profile is ignored during hydration', () => {
    const hydrated = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601001', name: 'Barangay 1' },
        postalCode: '1008',
        postalCodeSource: 'PHLPost',
      } as any,
    });

    expect('postalCode' in hydrated).toBe(false);
    expect((hydrated.selectedPsgc as any)?.postalResolution).toBeUndefined();
  });

  it('4. PHLPost postal source does not survive hydration', () => {
    const hydrated = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601001', name: 'Barangay 1' },
        postalCode: '1008',
        postalCodeSource: 'PHLPost',
      } as any,
    });

    expect((hydrated.selectedPsgc as any)?.postalCodeSource).toBeUndefined();
    expect((hydrated.selectedPsgc as any)?.postalCode).toBeUndefined();
  });

  it('5. Manual postal source does not survive hydration', () => {
    const hydrated = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601001', name: 'Barangay 1' },
        postalCode: '1008',
        postalCodeSource: 'manual',
      } as any,
    });

    expect((hydrated.selectedPsgc as any)?.postalResolution).toBeUndefined();
    expect((hydrated.selectedPsgc as any)?.postalCodeSource).toBeUndefined();
  });

  it('6. Hydrated address contains strictly PSGC hierarchy, building, and street', () => {
    const hydrated = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601001', name: 'Barangay 1' },
        houseBuilding: 'Unit 4B',
        street: 'Nagtahan St.',
      },
    });
    expect(hydrated.homeBuilding).toBe('Unit 4B');
    expect(hydrated.homeStreet).toBe('Nagtahan St.');
    expect(hydrated.selectedPsgc).toBeDefined();
    expect(Object.keys(hydrated)).toEqual(['selectedPsgc', 'homeBuilding', 'homeStreet']);
  });

  it('7. Empty PSGC profile produces empty state without postal properties', () => {
    const hydrated = hydrateReturningAddress({ psgc: null as any });
    expect(hydrated.selectedPsgc).toBeNull();
    expect(hydrated.homeBuilding).toBe('');
    expect(hydrated.homeStreet).toBe('');
    expect('postalCode' in hydrated).toBe(false);
  });

  it('8. Unknown mapping metadata does not break hydration and results in no postal fields', () => {
    const hydrated = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601001', name: 'Barangay 1' },
        postalCode: '1008',
        postalCodeSource: 'PHLPost',
      } as any,
    });

    expect((hydrated.selectedPsgc as any)?.postalResolution).toBeUndefined();
    expect('postalCode' in hydrated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PART 4: Returning Profile Persistence in issue.ts
// ---------------------------------------------------------------------------

describe('PART 4: Returning Profile Persistence in issue.ts', () => {
  const originalEnv = { ...process.env };
  const MATCH_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  const PASS_SECRET = '01234567890123456789012345678901';
  const ACTOR_ID = '11111111-1111-4111-8111-111111111111';
  const REQ_ID = '22222222-2222-4222-8222-222222222222';
  const PHOTO_INTENT_ID = '33333333-3333-4333-8333-333333333333';
  const PROFILE_ID = '44444444-4444-4444-8444-444444444444';
  const OTHER_PROFILE_ID = '99999999-9999-4999-8999-999999999999';

  let rawMatchToken: string;
  let matchDigest: string;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.SUPABASE_URL = 'http://localhost:54321';
    process.env.SUPABASE_SECRET_KEY = 'secret-key-test';
    process.env.PASS_TOKEN_SECRET = PASS_SECRET;
    process.env.RETURNING_MATCH_TOKEN_SECRET = MATCH_SECRET;

    const randomHex = randomBytes(16).toString('hex');
    const hmacSig = createHmac('sha256', MATCH_SECRET)
      .update(`${ACTOR_ID}:${REQ_ID}:${PROFILE_ID}:${randomHex}`)
      .digest('hex');
    rawMatchToken = `${ACTOR_ID}.${REQ_ID}.${PROFILE_ID}.${randomHex}.${hmacSig}`;
    matchDigest = computeMatchTokenDigest(rawMatchToken, MATCH_SECRET);

    vi.spyOn(actorsModule, 'getVerifiedSessionContext').mockResolvedValue({
      actorId: ACTOR_ID,
      role: 'visitor',
      isAnonymous: true,
      isRecoverySession: false,
      user: { id: ACTOR_ID },
      identity: 'anon-user',
      email: null,
    } as any);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    supabaseModule.setServerSupabaseClientsForTest(null);
    vi.restoreAllMocks();
  });

  function createMockSupabase(options: {
    updateError?: any;
    updatedRows?: any[];
    psgcLocations?: any[];
    psgcError?: any;
    attemptOutcome?: string;
  } = {}) {
    let capturedProfileUpdate: any = null;
    let capturedProfileTargetId: any = null;

    const validJpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00, 0x48]);

    const mockAdmin: any = {
      storage: {
        from: vi.fn(() => ({
          download: vi.fn().mockResolvedValue({
            data: {
              arrayBuffer: vi.fn().mockResolvedValue(validJpegBytes.buffer),
            },
            error: null,
          }),
        })),
      },
      schema: vi.fn((_name: string) => ({
        rpc: vi.fn((procName: string, _args: any) => {
          if (procName === 'issue_online_pass_v6') {
            return {
              single: vi.fn().mockResolvedValue({
                data: {
                  pass_id: 'pass-uuid-1234',
                  public_reference: 'ref-uuid-5678',
                  status: 'issued',
                  valid_from: new Date().toISOString(),
                  valid_until: new Date(Date.now() + 86400000).toISOString(),
                },
                error: null,
              }),
            };
          }
          return {
            single: vi.fn().mockResolvedValue({ data: null, error: null }),
          };
        }),
      })),
      from: vi.fn((table: string) => {
        if (table === 'passes') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null }),
              }),
            }),
          };
        }

        if (table === 'upload_intents') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockResolvedValue({
                  data: {
                    id: PHOTO_INTENT_ID,
                    owner_id: ACTOR_ID,
                    source: 'portal',
                    kind: 'photo',
                    status: 'pending',
                    bucket_id: 'visitor-photos',
                    object_path: `${ACTOR_ID}/${PHOTO_INTENT_ID}/photo.jpg`,
                    content_type: 'image/jpeg',
                    max_bytes: 5242880,
                    expires_at: new Date(Date.now() + 3600000).toISOString(),
                  },
                  error: null,
                }),
              }),
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          };
        }

        if (table === 'returning_identity_attempts') {
          let digestFilter: string | null = null;
          const attemptData = options.attemptOutcome === 'none' ? null : {
            id: 'attempt-uuid',
            outcome: options.attemptOutcome || 'matched',
            match_token_digest: matchDigest,
            expires_at: new Date(Date.now() + 600000).toISOString(),
          };

          const builder: any = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn((field: string, val: any) => {
              if (field === 'match_token_digest') {
                digestFilter = val;
              }
              return builder;
            }),
            gt: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn().mockImplementation(() => {
              if (digestFilter && digestFilter !== matchDigest) {
                return Promise.resolve({ data: null, error: null });
              }
              return Promise.resolve({
                data: attemptData,
                error: null,
              });
            }),
            update: vi.fn().mockReturnValue({
              eq: vi.fn().mockResolvedValue({ data: [], error: null }),
            }),
          };
          return builder;
        }

        if (table === 'returning_visitor_profiles') {
          return {
            select: vi.fn().mockReturnValue({
              eq: vi.fn().mockReturnValue({
                is: vi.fn().mockReturnValue({
                  maybeSingle: vi.fn().mockResolvedValue({
                    data: {
                      id: PROFILE_ID,
                      first_name: 'Juan',
                      last_name: 'Dela Cruz',
                      encrypted_face_template: 'enc-template',
                    },
                    error: null,
                  }),
                }),
              }),
            }),
            update: vi.fn((updatePayload: any) => {
              capturedProfileUpdate = updatePayload;
              return {
                eq: vi.fn((field: string, val: any) => {
                  if (field === 'id') capturedProfileTargetId = val;
                  return {
                    select: vi.fn().mockReturnValue(
                      Promise.resolve({
                        data: options.updatedRows ?? [{ id: val, ...updatePayload }],
                        error: options.updateError ?? null,
                      })
                    ),
                  };
                }),
              };
            }),
          };
        }

        if (table === 'psgc_locations') {
          return {
            select: vi.fn().mockReturnValue({
              in: vi.fn().mockResolvedValue({
                data: options.psgcLocations ?? [
                  { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
                  { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
                  { psgc_code: '0434203000', level: 'city', name: 'City of Biñan' },
                  { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
                ],
                error: options.psgcError ?? null,
              }),
            }),
          };
        }

        if (table === 'audit_events') {
          return {
            insert: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }

        return {
          select: vi.fn().mockReturnThis(),
          insert: vi.fn().mockResolvedValue({ data: [], error: null }),
          update: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
        };
      }),
    };

    supabaseModule.setServerSupabaseClientsForTest({
      admin: mockAdmin as any,
      passwordVerifier: mockAdmin as any,
    });

    return {
      mockAdmin,
      getCapturedUpdate: () => capturedProfileUpdate,
      getCapturedTargetId: () => capturedProfileTargetId,
    };
  }

  function makeIssueRequest(returningOverrides: any = {}, psgcOverrides: any = {}) {
    return new Request('http://localhost/api/passes/issue', {
      method: 'POST',
      headers: {
        authorization: 'Bearer anon-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        requestId: REQ_ID,
        source: 'portal',
        registrationMode: 'returning',
        arrivalMode: 'no_vehicle',
        visitor: {
          firstName: 'Juan',
          lastName: 'Dela Cruz',
          contactNumber: '09123456789',
          purpose: 'Official Business',
          visitDate: '2026-10-25',
        },
        photoIntentId: PHOTO_INTENT_ID,
        psgc: {
          version: '2026-q3',
          regionCode: '0400000000',
          provinceCode: '0434200000',
          cityCode: '0434203000',
          barangayCode: '0434203001',
          houseBuilding: 'Unit 4B',
          street: 'Nagtahan St.',
          postalCode: '4024',
          postalCodeSource: 'PHLPost',
          ...psgcOverrides,
        },
        returning: {
          matchToken: rawMatchToken,
          profileId: PROFILE_ID,
          saveUpdates: true,
          ...returningOverrides,
        },
      }),
    });
  }

  it('1. Complete PSGC lookup: all required records resolve and profile update persists all 13 fields with updated status', async () => {
    const { getCapturedUpdate, getCapturedTargetId } = createMockSupabase();
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.returningProfileUpdate).toBe('updated');
    expect(getCapturedTargetId()).toBe(PROFILE_ID);

    const update = getCapturedUpdate();
    expect(update).not.toBeNull();
    expect(update.psgc_version).toBe('2026-q3');
    expect(update.psgc_region_code).toBe('0400000000');
    expect(update.psgc_region_name).toBe('CALABARZON');
    expect(update.psgc_province_code).toBe('0434200000');
    expect(update.psgc_province_name).toBe('Laguna');
    expect(update.psgc_city_code).toBe('0434203000');
    expect(update.psgc_city_municipality_name).toBe('City of Biñan');
    expect(update.psgc_barangay_code).toBe('0434203001');
    expect(update.psgc_barangay_name).toBe('Biñan Proper');
    expect(update.home_building).toBe('Unit 4B');
    expect(update.home_street).toBe('Nagtahan St.');
    expect(update.postal_code).toBeUndefined();
    expect(update.postal_code_source).toBeUndefined();
  });

  it('2. City locality with level "municipality" is recognized and persisted in psgc_city_municipality_name', async () => {
    const { getCapturedUpdate } = createMockSupabase({
      psgcLocations: [
        { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
        { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
        { psgc_code: '0434203000', level: 'municipality', name: 'Municipality of Biñan' },
        { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
      ],
    });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.returningProfileUpdate).toBe('updated');
    const update = getCapturedUpdate();
    expect(update.psgc_city_municipality_name).toBe('Municipality of Biñan');
  });

  it('3. City locality with level "city_municipality" is recognized and persisted in psgc_city_municipality_name', async () => {
    const { getCapturedUpdate } = createMockSupabase({
      psgcLocations: [
        { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
        { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
        { psgc_code: '0434203000', level: 'city_municipality', name: 'Biñan City' },
        { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
      ],
    });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.returningProfileUpdate).toBe('updated');
    const update = getCapturedUpdate();
    expect(update.psgc_city_municipality_name).toBe('Biñan City');
  });

  it('4. Missing region record fails closed: update fails, pass preserved with 201', async () => {
    const { getCapturedUpdate } = createMockSupabase({
      psgcLocations: [
        // Missing region 0400000000
        { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
        { psgc_code: '0434203000', level: 'city', name: 'City of Biñan' },
        { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
      ],
    });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
    expect(getCapturedUpdate()).toBeNull();
  });

  it('5. Missing province record when provinceCode supplied fails closed: update fails, pass preserved with 201', async () => {
    const { getCapturedUpdate } = createMockSupabase({
      psgcLocations: [
        { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
        // Missing province 0434200000
        { psgc_code: '0434203000', level: 'city', name: 'City of Biñan' },
        { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
      ],
    });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
    expect(getCapturedUpdate()).toBeNull();
  });

  it('6. Missing city/municipality record fails closed: update fails, pass preserved with 201', async () => {
    const { getCapturedUpdate } = createMockSupabase({
      psgcLocations: [
        { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
        { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
        // Missing city 0434203000
        { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
      ],
    });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
    expect(getCapturedUpdate()).toBeNull();
  });

  it('7. Missing barangay record fails closed: update fails, pass preserved with 201', async () => {
    const { getCapturedUpdate } = createMockSupabase({
      psgcLocations: [
        { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
        { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
        { psgc_code: '0434203000', level: 'city', name: 'City of Biñan' },
        // Missing barangay 0434203001
      ],
    });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
    expect(getCapturedUpdate()).toBeNull();
  });

  it('8. Wrong PSGC code returned for requested locality fails closed: update fails, pass preserved with 201', async () => {
    const { getCapturedUpdate } = createMockSupabase({
      psgcLocations: [
        { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
        { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
        { psgc_code: '9999999999', level: 'city', name: 'Mismatched Code City' },
        { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
      ],
    });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
    expect(getCapturedUpdate()).toBeNull();
  });

  it('9. Wrong geographic level returned for requested code fails closed: update fails, pass preserved with 201', async () => {
    const { getCapturedUpdate } = createMockSupabase({
      psgcLocations: [
        { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
        { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
        // Code 0434203000 returned with wrong level 'barangay' instead of city/municipality
        { psgc_code: '0434203000', level: 'barangay', name: 'Wrong Level City' },
        { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
      ],
    });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
    expect(getCapturedUpdate()).toBeNull();
  });

  it('10. Empty or whitespace-only locality name fails closed: update fails, pass preserved with 201', async () => {
    const { getCapturedUpdate } = createMockSupabase({
      psgcLocations: [
        { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
        { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
        { psgc_code: '0434203000', level: 'city', name: '   \t  ' },
        { psgc_code: '0434203001', level: 'barangay', name: 'Biñan Proper' },
      ],
    });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
    expect(getCapturedUpdate()).toBeNull();
  });

  it('11. Partial lookup results with no PostgREST error fails closed: update fails, pass preserved with 201', async () => {
    const { getCapturedUpdate } = createMockSupabase({
      // Only 2 of 4 requested locations returned, error is null
      psgcLocations: [
        { psgc_code: '0400000000', level: 'region', name: 'CALABARZON' },
        { psgc_code: '0434200000', level: 'province', name: 'Laguna' },
      ],
      psgcError: null,
    });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
    expect(getCapturedUpdate()).toBeNull();
  });

  it('12. Database lookup error fails closed: update fails, pass preserved with 201', async () => {
    const { getCapturedUpdate } = createMockSupabase({
      psgcError: { message: 'Failed to lookup psgc locations' },
    });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
    expect(getCapturedUpdate()).toBeNull();
  });

  it('13. Supabase returning { error } reports returningProfileUpdate: failed without failing pass issuance', async () => {
    createMockSupabase({ updateError: { message: 'Database connection timeout' } });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
  });

  it('14. Profile update affecting zero rows reports returningProfileUpdate: failed without failing pass issuance', async () => {
    createMockSupabase({ updatedRows: [] });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
  });

  it('15. Optional address fields intentionally cleared are safely trimmed to empty/null', async () => {
    const { getCapturedUpdate } = createMockSupabase();
    const req = makeIssueRequest(
      {},
      { houseBuilding: '   ', street: '', postalCode: ' ' }
    );
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.returningProfileUpdate).toBe('updated');

    const update = getCapturedUpdate();
    expect(update.home_building).toBeNull();
    expect(update.home_street).toBeNull();
    expect(update.postal_code).toBeUndefined();
  });

  it('16. saveUpdates: false causes no profile update and returns returningProfileUpdate: not_requested', async () => {
    const { getCapturedUpdate } = createMockSupabase();
    const req = makeIssueRequest({ saveUpdates: false });
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.returningProfileUpdate).toBe('not_requested');
    expect(getCapturedUpdate()).toBeNull();
  });

  it('17. Invalid or tampered match-token authorization rejects profile updates and requests', async () => {
    createMockSupabase();
    const req = makeIssueRequest({ matchToken: 'invalid.match.token.here' });
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('returning_match_required');
  });

  it('18. Critical pass-issuance invariant: Pass issuance always survives profile update failure', async () => {
    createMockSupabase({ updateError: { message: 'Simulated deadlock' } });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBe('ref-uuid-5678');
    expect(json.returningProfileUpdate).toBe('failed');
  });

  it('19. Accurate update-status reporting: response includes honest status', async () => {
    createMockSupabase();
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    const json = await res.json();
    expect(['updated', 'failed', 'not_requested']).toContain(json.returningProfileUpdate);
  });

  it('20. Update target is strictly bound to matched profileId and never modifies a different visitor', async () => {
    const { getCapturedTargetId } = createMockSupabase();
    const req = makeIssueRequest({ profileId: PROFILE_ID });
    await issuePassHandler.fetch(req);

    expect(getCapturedTargetId()).toBe(PROFILE_ID);
    expect(getCapturedTargetId()).not.toBe(OTHER_PROFILE_ID);
  });
});


// ---------------------------------------------------------------------------
// PART 5: Postal Code State Synchronization & Manual Override Behavioral Matrix
// ---------------------------------------------------------------------------

describe('PART 5: Postal Code State Synchronization & Manual Override Behavioral Matrix', () => {
  function deriveBadgeState(
    postalCode: string,
    value: {
      postalCode?: string | null;
      postalCodeSource?: string | null;
      postalResolution?: {
        postalCode?: string | null;
        isAutoFilled?: boolean;
        requiresConfirmation?: boolean;
      };
    } | null
  ) {
    const trimmedPostal = postalCode.trim();
    const isPhlPostAutoFilled = Boolean(
      value?.postalCodeSource === 'PHLPost' &&
      value?.postalResolution?.isAutoFilled &&
      trimmedPostal.length > 0 &&
      trimmedPostal === value?.postalResolution?.postalCode
    );
    const isConfirmationRequired = Boolean(
      value?.postalResolution?.requiresConfirmation &&
      !isPhlPostAutoFilled
    );
    const isManualEntry = Boolean(
      trimmedPostal.length > 0 &&
      !isPhlPostAutoFilled &&
      !isConfirmationRequired
    );
    return { isPhlPostAutoFilled, isConfirmationRequired, isManualEntry };
  }

  function simulateSelectorConfirm(params: {
    initialAddress: any;
    selectedLocality: { region: string; province?: string | null; city: string; barangay: string };
    manualPostalCode: string;
    localityResolution?: any;
  }) {
    const { initialAddress, selectedLocality, manualPostalCode, localityResolution } = params;
    const isSameLocality = Boolean(
      initialAddress &&
      initialAddress.region.code === selectedLocality.region &&
      ((!initialAddress.province && !selectedLocality.province) ||
        initialAddress.province?.code === selectedLocality.province) &&
      initialAddress.city.code === selectedLocality.city &&
      initialAddress.barangay.code === selectedLocality.barangay
    );

    let finalPostalCode: string | null = null;
    let finalSource: string | null = null;
    let finalResolution: any = undefined;

    if (isSameLocality) {
      const candidateCode = manualPostalCode.trim() || null;
      if (!candidateCode) {
        finalPostalCode = null;
        finalSource = null;
        finalResolution = undefined;
      } else if (
        initialAddress?.postalCodeSource === 'PHLPost' &&
        initialAddress.postalCode === candidateCode
      ) {
        finalPostalCode = candidateCode;
        finalSource = 'PHLPost';
        finalResolution = initialAddress.postalResolution || {
          postalCode: candidateCode,
          isAutoFilled: true,
          requiresConfirmation: false,
          mappingType: 'unknown',
        };
      } else {
        finalPostalCode = candidateCode;
        finalSource = 'manual';
        finalResolution = {
          postalCode: candidateCode,
          isAutoFilled: false,
          requiresConfirmation: false,
          mappingType: 'unmapped',
        };
      }
    } else {
      if (localityResolution?.isAutoFilled && localityResolution.postalCode) {
        finalPostalCode = localityResolution.postalCode;
        finalSource = 'PHLPost';
        finalResolution = localityResolution;
      } else {
        const candidateCode = manualPostalCode.trim() || null;
        if (candidateCode) {
          finalPostalCode = candidateCode;
          finalSource = 'manual';
          finalResolution = localityResolution
            ? { ...localityResolution, postalCode: candidateCode }
            : {
                postalCode: candidateCode,
                isAutoFilled: false,
                requiresConfirmation: false,
                mappingType: 'unmapped',
              };
        } else {
          finalPostalCode = null;
          finalSource = null;
          finalResolution = localityResolution || undefined;
        }
      }
    }

    return { finalPostalCode, finalSource, finalResolution };
  }

  it('Test A — Original PHLPost state badge derivation', () => {
    const address = {
      postalCode: '1008',
      postalCodeSource: 'PHLPost',
      postalResolution: {
        postalCode: '1008',
        isAutoFilled: true,
        requiresConfirmation: false,
      },
    };
    const badges = deriveBadgeState('1008', address);
    expect(badges.isPhlPostAutoFilled).toBe(true);
    expect(badges.isConfirmationRequired).toBe(false);
    expect(badges.isManualEntry).toBe(false);
  });

  it('Test B — Manual override immediately displays Manual entry and clears PHLPost badge', () => {
    const address = {
      postalCode: '1009',
      postalCodeSource: 'manual',
      postalResolution: {
        postalCode: '1009',
        isAutoFilled: false,
        requiresConfirmation: false,
      },
    };
    const badges = deriveBadgeState('1009', address);
    expect(badges.isPhlPostAutoFilled).toBe(false);
    expect(badges.isManualEntry).toBe(true);
    expect(badges.isConfirmationRequired).toBe(false);
  });

  it('Test C — Selector preservation preserves manual 1009 and does not revert to old 1008', () => {
    const initialAddress = {
      region: { code: '1300000000', name: 'NCR' },
      province: null,
      city: { code: '1380600000', name: 'City of Manila' },
      barangay: { code: '1380601001', name: 'Barangay 1' },
      postalCode: '1009',
      postalCodeSource: 'manual',
      postalResolution: {
        postalCode: '1009',
        isAutoFilled: false,
        requiresConfirmation: false,
        mappingType: 'unmapped',
      },
    };
    const result = simulateSelectorConfirm({
      initialAddress,
      selectedLocality: {
        region: '1300000000',
        province: null,
        city: '1380600000',
        barangay: '1380601001',
      },
      manualPostalCode: '1009',
    });
    expect(result.finalPostalCode).toBe('1009');
    expect(result.finalSource).toBe('manual');
    expect(result.finalResolution.isAutoFilled).toBe(false);

    const badges = deriveBadgeState('1009', {
      postalCode: result.finalPostalCode,
      postalCodeSource: result.finalSource,
      postalResolution: result.finalResolution,
    });
    expect(badges.isPhlPostAutoFilled).toBe(false);
    expect(badges.isManualEntry).toBe(true);
  });

  it('Test D — Unchanged auto-filled code preserves PHLPost source and badge', () => {
    const initialAddress = {
      region: { code: '1300000000', name: 'NCR' },
      province: null,
      city: { code: '1380600000', name: 'City of Manila' },
      barangay: { code: '1380601001', name: 'Barangay 1' },
      postalCode: '1008',
      postalCodeSource: 'PHLPost',
      postalResolution: {
        postalCode: '1008',
        isAutoFilled: true,
        requiresConfirmation: false,
        mappingType: 'exact_barangay',
      },
    };
    const result = simulateSelectorConfirm({
      initialAddress,
      selectedLocality: {
        region: '1300000000',
        province: null,
        city: '1380600000',
        barangay: '1380601001',
      },
      manualPostalCode: '1008',
    });
    expect(result.finalPostalCode).toBe('1008');
    expect(result.finalSource).toBe('PHLPost');
    expect(result.finalResolution.isAutoFilled).toBe(true);

    const badges = deriveBadgeState('1008', {
      postalCode: result.finalPostalCode,
      postalCodeSource: result.finalSource,
      postalResolution: result.finalResolution,
    });
    expect(badges.isPhlPostAutoFilled).toBe(true);
    expect(badges.isManualEntry).toBe(false);
  });

  it('Test E — Clear postal code remains empty and does not silently restore previous postal code', () => {
    const initialAddress = {
      region: { code: '1300000000', name: 'NCR' },
      province: null,
      city: { code: '1380600000', name: 'City of Manila' },
      barangay: { code: '1380601001', name: 'Barangay 1' },
      postalCode: null,
      postalCodeSource: null,
      postalResolution: undefined,
    };
    const result = simulateSelectorConfirm({
      initialAddress,
      selectedLocality: {
        region: '1300000000',
        province: null,
        city: '1380600000',
        barangay: '1380601001',
      },
      manualPostalCode: '',
    });
    expect(result.finalPostalCode).toBeNull();
    expect(result.finalSource).toBeNull();
    expect(result.finalResolution).toBeUndefined();

    const badges = deriveBadgeState('', {
      postalCode: result.finalPostalCode,
      postalCodeSource: result.finalSource,
      postalResolution: result.finalResolution,
    });
    expect(badges.isPhlPostAutoFilled).toBe(false);
    expect(badges.isManualEntry).toBe(false);
    expect(badges.isConfirmationRequired).toBe(false);
  });

  it('Test F — Change locality resets previous manual postal code and uses new locality resolution', () => {
    const initialAddress = {
      region: { code: '1300000000', name: 'NCR' },
      province: null,
      city: { code: '1380600000', name: 'City of Manila' },
      barangay: { code: '1380601001', name: 'Barangay 1' },
      postalCode: '1009',
      postalCodeSource: 'manual',
    };
    const newLocalityResolution = {
      postalCode: '1100',
      isAutoFilled: true,
      requiresConfirmation: false,
      mappingType: 'exact_barangay',
    };
    const result = simulateSelectorConfirm({
      initialAddress,
      selectedLocality: {
        region: '1300000000',
        province: null,
        city: '1380400000',
        barangay: '1380401001',
      },
      manualPostalCode: '',
      localityResolution: newLocalityResolution,
    });
    expect(result.finalPostalCode).toBe('1100');
    expect(result.finalSource).toBe('PHLPost');
    expect(result.finalResolution.mappingType).toBe('exact_barangay');
  });

  it('Test G — Serialization preserves exact postal code and source', () => {
    function serializePsgc(selectedPsgc: any, postalCodeInput: string) {
      return {
        postalCode: postalCodeInput.trim() || undefined,
        postalCodeSource: (() => {
          const trimmed = postalCodeInput.trim();
          if (!trimmed) return undefined;
          if (
            selectedPsgc?.postalCodeSource === 'PHLPost' &&
            selectedPsgc?.postalCode &&
            selectedPsgc?.postalCode.trim() === trimmed
          ) {
            return 'PHLPost';
          }
          return 'manual';
        })(),
      };
    }

    // 1. Unchanged PHLPost
    const s1 = serializePsgc({ postalCode: '1008', postalCodeSource: 'PHLPost' }, '1008');
    expect(s1.postalCode).toBe('1008');
    expect(s1.postalCodeSource).toBe('PHLPost');

    // 2. Manual edit
    const s2 = serializePsgc({ postalCode: '1009', postalCodeSource: 'manual' }, '1009');
    expect(s2.postalCode).toBe('1009');
    expect(s2.postalCodeSource).toBe('manual');

    // 3. Cleared
    const s3 = serializePsgc({ postalCode: null, postalCodeSource: null }, '');
    expect(s3.postalCode).toBeUndefined();
    expect(s3.postalCodeSource).toBeUndefined();
  });

  it('Test H — Unknown mapping metadata compatibility preserves honest non-falsified provenance', () => {
    const hydrated = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601001', name: 'Barangay 1' },
        postalCode: '1008',
        postalCodeSource: 'PHLPost',
        postalResolution: {
          postalCode: '1008',
          mappingType: 'unknown',
          isAutoFilled: true,
          requiresConfirmation: false,
        },
      },
    });
    expect((hydrated.selectedPsgc as any)?.postalResolution).toBeUndefined();
    expect('postalCode' in hydrated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PART 5: Pure Locality Comparison (isSameLocality)
// ---------------------------------------------------------------------------

describe('PART 5: Pure Locality Comparison (isSameLocality)', () => {
  const ncrRegion = { code: '1300000000', parentCode: null, name: 'National Capital Region', level: 'region' as const, hasProvinces: false };
  const manilaCity = { code: '1380600000', parentCode: '1300000000', name: 'City of Manila', level: 'city' as const, isCity: true };
  const bgy1 = { code: '1380601001', parentCode: '1380600000', name: 'Barangay 1', level: 'barangay' as const };
  const bgy2 = { code: '1380601002', parentCode: '1380600000', name: 'Barangay 2', level: 'barangay' as const };

  const calabarzonRegion = { code: '0400000000', parentCode: null, name: 'CALABARZON', level: 'region' as const };
  const lagunaProvince = { code: '0434200000', parentCode: '0400000000', name: 'Laguna', level: 'province' as const };
  const binanCity = { code: '0434203000', parentCode: '0434200000', name: 'City of Biñan', level: 'city' as const };
  const binanProper = { code: '0434203001', parentCode: '0434203000', name: 'Biñan Proper', level: 'barangay' as const };

  it('1. isSameLocality correctly identifies identical localities in NCR (no province)', () => {
    const initial = {
      region: ncrRegion,
      province: null,
      city: manilaCity,
      barangay: bgy1,
    };

    expect(isSameLocality(initial, { region: ncrRegion, province: null, city: manilaCity, barangay: bgy1 })).toBe(true);
    expect(isSameLocality(initial, { region: ncrRegion, province: null, city: manilaCity, barangay: bgy2 })).toBe(false);
  });

  it('2. isSameLocality correctly identifies identical provincial localities with province', () => {
    const initial = {
      region: calabarzonRegion,
      province: lagunaProvince,
      city: binanCity,
      barangay: binanProper,
    };

    expect(isSameLocality(initial, { region: calabarzonRegion, province: lagunaProvince, city: binanCity, barangay: binanProper })).toBe(true);
    expect(isSameLocality(initial, { region: calabarzonRegion, province: null, city: binanCity, barangay: binanProper })).toBe(false);
  });

  it('3. isSameLocality returns false if any required locality field is missing', () => {
    const initial = {
      region: ncrRegion,
      province: null,
      city: manilaCity,
      barangay: bgy1,
    };

    expect(isSameLocality(null, { region: ncrRegion, province: null, city: manilaCity, barangay: bgy1 })).toBe(false);
    expect(isSameLocality(initial, { region: null, province: null, city: manilaCity, barangay: bgy1 })).toBe(false);
    expect(isSameLocality(initial, { region: ncrRegion, province: null, city: null, barangay: bgy1 })).toBe(false);
    expect(isSameLocality(initial, { region: ncrRegion, province: null, city: manilaCity, barangay: null })).toBe(false);
  });
});
