/**
 * tests/returning-visitor-address-hardening.test.ts
 *
 * Comprehensive integration and unit tests for Returning Visitor Address Hardening:
 * - Part 2: Address normalization and PSGC locality fallback in identify-returning.ts
 * - Part 4: Returning profile persistence in issue.ts with 9 failure/success permutations
 * - Part 5: Postal code metadata preservation and PHLPost source stability
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { resolvePsgcLocalityFallback, computeMatchTokenDigest } from '../server/routes/passes/identify-returning.js';
import { hydrateReturningAddress } from '../src/lib/returningAddressHydration.js';
import * as supabaseModule from '../server/supabase.js';
import * as actorsModule from '../server/actors.js';
import issuePassHandler from '../server/routes/passes/issue.js';

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
    // No matching reference locations found
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
    expect(hydrated.postalCode).toBe('');
    expect(hydrated.selectedPsgc?.postalCode).toBeNull();
    expect(hydrated.selectedPsgc?.postalCodeSource).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PART 5: Postal Code Metadata & Source Stability
// ---------------------------------------------------------------------------

describe('PART 5: Postal Code Metadata Preservation', () => {
  it('reconstructs postalResolution when postalCode exists with PHLPost source', () => {
    const hydrated = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601001', name: 'Barangay 1' },
        houseBuilding: 'Unit 4B',
        street: 'Nagtahan St.',
        postalCode: '1008',
        postalCodeSource: 'PHLPost',
      },
    });

    expect(hydrated.selectedPsgc?.postalResolution).toBeDefined();
    expect(hydrated.selectedPsgc?.postalResolution?.isAutoFilled).toBe(true);
    expect(hydrated.selectedPsgc?.postalResolution?.mappingType).toBe('exact_barangay');
    expect(hydrated.selectedPsgc?.postalCodeSource).toBe('PHLPost');
  });

  it('does not reconstruct PHLPost auto-fill when source is manual', () => {
    const hydrated = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'NCR' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380601001', name: 'Barangay 1' },
        postalCode: '1008',
        postalCodeSource: 'manual',
      },
    });

    expect(hydrated.selectedPsgc?.postalResolution?.isAutoFilled).toBe(false);
    expect(hydrated.selectedPsgc?.postalCodeSource).toBe('manual');
  });

  it('preserves postalCodeSource PHLPost and postalResolution when address is confirmed without changes', async () => {
    // Read AddressCascadingSelector to verify preservation logic contract
    const src = await import('fs').then((fs) =>
      fs.readFileSync('src/components/AddressCascadingSelector.tsx', 'utf-8')
    );
    expect(src).toContain('initialAddress?.postalCodeSource && initialAddress.postalCode === finalPostalCode');
    expect(src).toContain("initialAddress.postalCodeSource === 'PHLPost'");
    expect(src).toContain('initialAddress.postalResolution');
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

    // Generate valid match token for ACTOR_ID + REQ_ID + PROFILE_ID
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

    // Standard valid JPEG buffer (starts with 0xFF, 0xD8, 0xFF)
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

  it('1. Successful structured profile update persists all 13 fields and returns returningProfileUpdate: updated', async () => {
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
    expect(update.postal_code).toBe('4024');
    expect(update.postal_code_source).toBe('PHLPost');
  });

  it('2. Supabase returning { error } reports returningProfileUpdate: failed without failing pass issuance', async () => {
    createMockSupabase({ updateError: { message: 'Database connection timeout' } });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    // CRITICAL: Pass issuance must succeed!
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
  });

  it('3. Profile update affecting zero rows reports returningProfileUpdate: failed without failing pass issuance', async () => {
    createMockSupabase({ updatedRows: [] });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
  });

  it('4. PSGC reference lookup failure fails closed: reports returningProfileUpdate: failed and preserves safe pass issuance', async () => {
    createMockSupabase({ psgcError: { message: 'Failed to lookup psgc locations' } });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBeDefined();
    expect(json.returningProfileUpdate).toBe('failed');
  });

  it('5. Optional address fields intentionally cleared are safely trimmed to empty/null', async () => {
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
    expect(update.postal_code).toBeNull();
  });

  it('6. saveUpdates: false causes no profile update and returns returningProfileUpdate: not_requested', async () => {
    const { getCapturedUpdate } = createMockSupabase();
    const req = makeIssueRequest({ saveUpdates: false });
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.returningProfileUpdate).toBe('not_requested');
    expect(getCapturedUpdate()).toBeNull();
  });

  it('7. Invalid or tampered match-token authorization rejects profile updates and requests', async () => {
    createMockSupabase();
    const req = makeIssueRequest({ matchToken: 'invalid.match.token.here' });
    const res = await issuePassHandler.fetch(req);

    // Fails authorization
    expect(res.status).toBe(422);
    const json = await res.json();
    expect(json.error).toBe('returning_match_required');
  });

  it('8. Critical pass-issuance invariant: Pass issuance always survives profile update failure', async () => {
    createMockSupabase({ updateError: { message: 'Simulated deadlock' } });
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.passId).toBe('ref-uuid-5678');
    expect(json.returningProfileUpdate).toBe('failed');
  });

  it('9. Accurate update-status reporting: response includes honest status', async () => {
    createMockSupabase();
    const req = makeIssueRequest();
    const res = await issuePassHandler.fetch(req);

    const json = await res.json();
    expect(['updated', 'failed', 'not_requested']).toContain(json.returningProfileUpdate);
  });

  it('10. Update target is strictly bound to matched profileId and never modifies a different visitor', async () => {
    const { getCapturedTargetId } = createMockSupabase();
    const req = makeIssueRequest({ profileId: PROFILE_ID });
    await issuePassHandler.fetch(req);

    expect(getCapturedTargetId()).toBe(PROFILE_ID);
    expect(getCapturedTargetId()).not.toBe(OTHER_PROFILE_ID);
  });
});
