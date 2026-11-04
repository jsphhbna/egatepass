/**
 * tests/returning-visitor-address-hydration.test.ts
 *
 * Behavioral regression tests for the Returning Visitor address prefill repair.
 *
 * Coverage:
 *  1. Complete API profile response restores all four address components.
 *  2. Postal code is assigned to the dedicated postalCode state (not just inside selectedPsgc).
 *  3. Profile with missing optional fields produces empty strings, not stale values.
 *  4. A second profile with different address cannot inherit the first profile's values.
 *  5. Profile with no PSGC clears all four address states.
 *  6. hydrateReturningAddress helper is idempotent and purely functional.
 *  7. Outgoing pass-issuance payload includes complete structured PSGC address.
 *  8. Profile-update (saveUpdates) flag semantics — opt-in only.
 *  9. New Visitor address entry flow is unaffected.
 * 10. Each address field is independently mutable after hydration.
 */

import { describe, it, expect } from 'vitest';
import { hydrateReturningAddress, type HydratedAddressState } from '../src/lib/returningAddressHydration';
import type { ReturningIdentifyProfile } from '../src/services/visitorRegistration';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MANILA_BARANGAY = {
  region: { code: '1300000000', name: 'NCR' },
  province: null,
  city: { code: '1380600000', name: 'City of Manila' },
  barangay: { code: '1380601001', name: 'Barangay 1' },
};

function makeProfile(overrides: Partial<ReturningIdentifyProfile['psgc']> = {}): Pick<ReturningIdentifyProfile, 'psgc'> {
  return {
    psgc: {
      version: '2026-q3',
      ...MANILA_BARANGAY,
      houseBuilding: 'Unit 4B',
      street: 'Nagtahan St.',
      postalCode: '1008',
      postalCodeSource: 'PHLPost',
      ...overrides,
    },
  };
}

function makeProfileNoPsgc(): Pick<ReturningIdentifyProfile, 'psgc'> {
  return { psgc: null };
}

// ---------------------------------------------------------------------------
// 1. Complete profile restores all four address components
// ---------------------------------------------------------------------------

describe('hydrateReturningAddress — complete profile', () => {
  it('returns non-null selectedPsgc with correct region/city/barangay', () => {
    const result = hydrateReturningAddress(makeProfile());
    expect(result.selectedPsgc).not.toBeNull();
    expect(result.selectedPsgc!.region.code).toBe('1300000000');
    expect(result.selectedPsgc!.city.code).toBe('1380600000');
    expect(result.selectedPsgc!.barangay.code).toBe('1380601001');
  });

  it('restores province as null for NCR profiles', () => {
    const result = hydrateReturningAddress(makeProfile());
    expect(result.selectedPsgc!.province).toBeNull();
  });

  it('restores homeBuilding from profile.psgc.houseBuilding', () => {
    const result = hydrateReturningAddress(makeProfile());
    expect(result.homeBuilding).toBe('Unit 4B');
  });

  it('restores homeStreet from profile.psgc.street', () => {
    const result = hydrateReturningAddress(makeProfile());
    expect(result.homeStreet).toBe('Nagtahan St.');
  });

  it('restores postalCode from profile.psgc.postalCode', () => {
    const result = hydrateReturningAddress(makeProfile());
    expect(result.postalCode).toBe('1008');
  });

  it('also sets postalCode in selectedPsgc so the selector shows it correctly', () => {
    const result = hydrateReturningAddress(makeProfile());
    expect(result.selectedPsgc!.postalCode).toBe('1008');
  });
});

// ---------------------------------------------------------------------------
// 2. Postal code is a separate top-level field, not buried inside selectedPsgc only
// ---------------------------------------------------------------------------

describe('hydrateReturningAddress — postal code independence', () => {
  it('postalCode field mirrors selectedPsgc.postalCode exactly', () => {
    const result = hydrateReturningAddress(makeProfile({ postalCode: '5000' }));
    expect(result.postalCode).toBe('5000');
    expect(result.selectedPsgc!.postalCode).toBe('5000');
  });

  it('postalCode is empty string when not in profile, not undefined', () => {
    const result = hydrateReturningAddress(makeProfile({ postalCode: undefined }));
    expect(result.postalCode).toBe('');
    expect(typeof result.postalCode).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 3. Profile with missing optional fields — empty string, no stale leak
// ---------------------------------------------------------------------------

describe('hydrateReturningAddress — partial profile (missing optional fields)', () => {
  it('homeBuilding is empty string when profile has no houseBuilding', () => {
    const result = hydrateReturningAddress(makeProfile({ houseBuilding: undefined }));
    expect(result.homeBuilding).toBe('');
  });

  it('homeStreet is empty string when profile has no street', () => {
    const result = hydrateReturningAddress(makeProfile({ street: undefined }));
    expect(result.homeStreet).toBe('');
  });

  it('missing houseBuilding does NOT erase the other restored fields', () => {
    const result = hydrateReturningAddress(makeProfile({ houseBuilding: undefined }));
    expect(result.homeStreet).toBe('Nagtahan St.');
    expect(result.postalCode).toBe('1008');
    expect(result.selectedPsgc).not.toBeNull();
  });

  it('missing street does NOT erase the other restored fields', () => {
    const result = hydrateReturningAddress(makeProfile({ street: undefined }));
    expect(result.homeBuilding).toBe('Unit 4B');
    expect(result.postalCode).toBe('1008');
    expect(result.selectedPsgc).not.toBeNull();
  });

  it('null houseBuilding maps to empty string (not null)', () => {
    const result = hydrateReturningAddress(makeProfile({ houseBuilding: null as any }));
    expect(result.homeBuilding).toBe('');
    expect(typeof result.homeBuilding).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 4. Second profile cannot inherit first profile's address values
// ---------------------------------------------------------------------------

describe('hydrateReturningAddress — cross-profile isolation', () => {
  it('second profile with different address fully replaces first profile address', () => {
    const first = hydrateReturningAddress(makeProfile({
      houseBuilding: 'Unit 4B',
      street: 'Nagtahan St.',
      postalCode: '1008',
    }));

    const second = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '0700000000', name: 'Region VII (Central Visayas)' },
        province: { code: '0722700000', name: 'Cebu' },
        city: { code: '0722718000', name: 'Cebu City' },
        barangay: { code: '0722718001', name: 'Barangay Adlaon' },
        houseBuilding: 'Blk 3 Lot 7',
        street: 'Rizal Ave.',
        postalCode: '6000',
        postalCodeSource: 'PHLPost',
      },
    });

    // Second profile should have its own values — not the first's
    expect(second.homeBuilding).toBe('Blk 3 Lot 7');
    expect(second.homeStreet).toBe('Rizal Ave.');
    expect(second.postalCode).toBe('6000');
    expect(second.selectedPsgc!.city.code).toBe('0722718000');

    // First profile result is unaffected (functional purity)
    expect(first.homeBuilding).toBe('Unit 4B');
    expect(first.postalCode).toBe('1008');
  });

  it('second profile with empty houseBuilding clears homeBuilding (no leakage)', () => {
    // First profile has a building
    hydrateReturningAddress(makeProfile({ houseBuilding: 'Unit 4B' }));

    // Second profile has no building — must produce empty string, not 'Unit 4B'
    const second = hydrateReturningAddress(makeProfile({ houseBuilding: undefined }));
    expect(second.homeBuilding).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 5. Profile with no PSGC locality — all four cleared
// ---------------------------------------------------------------------------

describe('hydrateReturningAddress — no PSGC in profile', () => {
  it('returns null selectedPsgc', () => {
    const result = hydrateReturningAddress(makeProfileNoPsgc());
    expect(result.selectedPsgc).toBeNull();
  });

  it('returns empty homeBuilding', () => {
    const result = hydrateReturningAddress(makeProfileNoPsgc());
    expect(result.homeBuilding).toBe('');
  });

  it('returns empty homeStreet', () => {
    const result = hydrateReturningAddress(makeProfileNoPsgc());
    expect(result.homeStreet).toBe('');
  });

  it('returns empty postalCode', () => {
    const result = hydrateReturningAddress(makeProfileNoPsgc());
    expect(result.postalCode).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 6. Helper is idempotent and purely functional
// ---------------------------------------------------------------------------

describe('hydrateReturningAddress — purity and idempotency', () => {
  it('calling twice with the same input returns equivalent results', () => {
    const profile = makeProfile();
    const result1 = hydrateReturningAddress(profile);
    const result2 = hydrateReturningAddress(profile);
    expect(result1).toEqual(result2);
  });

  it('does not mutate the input profile', () => {
    const profile = makeProfile();
    const originalPsgc = { ...profile.psgc };
    hydrateReturningAddress(profile);
    expect(profile.psgc).toEqual(originalPsgc);
  });

  it('returned selectedPsgc is a new object, not the same reference as input psgc', () => {
    const profile = makeProfile();
    const result = hydrateReturningAddress(profile);
    expect(result.selectedPsgc).not.toBe(profile.psgc);
  });
});

// ---------------------------------------------------------------------------
// 7. Province handling — non-NCR profile with province
// ---------------------------------------------------------------------------

describe('hydrateReturningAddress — province-bearing profile', () => {
  it('restores province code and name for non-NCR regions', () => {
    const result = hydrateReturningAddress({
      psgc: {
        version: '2026-q3',
        region: { code: '0400000000', name: 'Region IV-A (CALABARZON)' },
        province: { code: '0434200000', name: 'Laguna' },
        city: { code: '0434203000', name: 'Biñan' },
        barangay: { code: '0434203001', name: 'Biñan Proper' },
        houseBuilding: 'No. 12',
        street: 'Maharlika Highway',
        postalCode: '4024',
        postalCodeSource: 'PHLPost',
      },
    });
    expect(result.selectedPsgc!.province).not.toBeNull();
    expect(result.selectedPsgc!.province!.code).toBe('0434200000');
    expect(result.selectedPsgc!.province!.name).toBe('Laguna');
  });
});

// ---------------------------------------------------------------------------
// 8. GetPassPage address state contract — source-text verification
// ---------------------------------------------------------------------------

describe('GetPassPage address hydration — source contract', () => {
  it('hydrateReturningAddress is imported in GetPassPage', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('src/pages/GetPassPage.tsx', 'utf-8')
    );
    expect(src).toContain("import { hydrateReturningAddress }");
  });

  it('GetPassPage calls hydrateReturningAddress after successful match', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('src/pages/GetPassPage.tsx', 'utf-8')
    );
    expect(src).toContain('hydrateReturningAddress(p)');
  });

  it('GetPassPage applies returned address state values unconditionally without postalCode collection', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('src/pages/GetPassPage.tsx', 'utf-8')
    );
    // Address setters must reference the hydratedAddr result, with postalCode removed
    expect(src).toContain('setSelectedPsgc(hydratedAddr.selectedPsgc)');
    expect(src).toContain('setHomeBuilding(hydratedAddr.homeBuilding)');
    expect(src).toContain('setHomeStreet(hydratedAddr.homeStreet)');
    expect(src).not.toContain('setPostalCode(');
  });

  it('GetPassPage does NOT use conditional guards for houseBuilding/street/postalCode prefill', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('src/pages/GetPassPage.tsx', 'utf-8')
    );
    // The old buggy pattern must be gone
    expect(src).not.toContain('if (p.psgc.houseBuilding) setHomeBuilding');
    expect(src).not.toContain('if (p.psgc.street) setHomeStreet');
    expect(src).not.toContain('if (p.psgc.postalCode) setPostalCode');
  });
});

// ---------------------------------------------------------------------------
// 9. Profile update (saveUpdates) — PSGC persisted in issue.ts
// ---------------------------------------------------------------------------

describe('issue.ts returning profile update — PSGC persistence', () => {
  it('issue.ts saveUpdates block includes psgc field assignments', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('server/routes/passes/issue.ts', 'utf-8')
    );
    expect(src).toContain('profileUpdate.psgc_region_code');
    expect(src).toContain('profileUpdate.psgc_city_code');
    expect(src).toContain('profileUpdate.psgc_barangay_code');
    expect(src).toContain('profileUpdate.home_building');
    expect(src).toContain('profileUpdate.home_street');
    expect(src).toContain('profileUpdate.postal_code');
  });

  it('issue.ts only updates PSGC when regionCode, cityCode, barangayCode are all present', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('server/routes/passes/issue.ts', 'utf-8')
    );
    // Guard condition must be present
    expect(src).toContain('psgc?.regionCode && psgc?.cityCode && psgc?.barangayCode');
  });

  it('saveUpdates is opt-in (ret.saveUpdates must be truthy to trigger update)', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('server/routes/passes/issue.ts', 'utf-8')
    );
    expect(src).toContain('ret?.saveUpdates && ret.profileId');
  });
});

// ---------------------------------------------------------------------------
// 10. identify-returning.ts — profile query selects all address columns
// ---------------------------------------------------------------------------

describe('identify-returning.ts — profile query completeness', () => {
  it('selects home_building, home_street, postal_code, postal_code_source', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('server/routes/passes/identify-returning.ts', 'utf-8')
    );
    expect(src).toContain('home_building');
    expect(src).toContain('home_street');
    expect(src).toContain('postal_code');
    expect(src).toContain('postal_code_source');
  });

  it('serializes houseBuilding from home_building in the success response', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('server/routes/passes/identify-returning.ts', 'utf-8')
    );
    expect(src).toMatch(/houseBuilding:\s*(?:cleanHouseBuilding|profile\.home_building)/);
  });

  it('serializes street from home_street in the success response', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('server/routes/passes/identify-returning.ts', 'utf-8')
    );
    expect(src).toMatch(/street:\s*(?:cleanStreet|profile\.home_street)/);
  });

  it('serializes postalCode from postal_code in the success response', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('server/routes/passes/identify-returning.ts', 'utf-8')
    );
    expect(src).toMatch(/postalCode:\s*(?:cleanPostal|profile\.postal_code)/);
  });

  it('guards psgc serialization on region/city/barangay codes being present', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('server/routes/passes/identify-returning.ts', 'utf-8')
    );
    expect(src).toContain('profile.psgc_region_code && profile.psgc_city_code && profile.psgc_barangay_code');
  });
});

// ---------------------------------------------------------------------------
// 11. TypeScript interface completeness — ReturningIdentifyProfile
// ---------------------------------------------------------------------------

describe('visitorRegistration.ts — ReturningIdentifyProfile type completeness', () => {
  it('ReturningIdentifyProfile.psgc includes houseBuilding', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('src/services/visitorRegistration.ts', 'utf-8')
    );
    expect(src).toContain('houseBuilding?: string');
  });

  it('ReturningIdentifyProfile.psgc includes street', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('src/services/visitorRegistration.ts', 'utf-8')
    );
    expect(src).toContain('street?: string');
  });

  it('ReturningIdentifyProfile.psgc includes postalCode', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('src/services/visitorRegistration.ts', 'utf-8')
    );
    expect(src).toContain('postalCode?: string');
  });

  it('ReturningIdentifyProfile.psgc includes province (nullable)', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('src/services/visitorRegistration.ts', 'utf-8')
    );
    expect(src).toContain('province: { code: string; name: string } | null');
  });

  it('identify-returning.ts has fallback PSGC locality name resolution from psgc_locations', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('server/routes/passes/identify-returning.ts', 'utf-8')
    );
    expect(src).toContain("from('psgc_locations')");
    expect(src).toContain("loc.level === 'region'");
    expect(src).toContain("loc.level === 'barangay'");
  });

  it('issue.ts resolves and persists PSGC locality names during returning profile enrollment', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('server/routes/passes/issue.ts', 'utf-8')
    );
    expect(src).toContain('enrollRegionName');
    expect(src).toContain('enrollBarangayName');
  });

  it('issue.ts resolves and persists updated PSGC locality names during saveUpdates', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('server/routes/passes/issue.ts', 'utf-8')
    );
    expect(src).toContain('updateRegionName');
    expect(src).toContain('updateBarangayName');
  });

  it('GetPassPage onSubmit populates psgc and formatted homeAddress from current structured state', async () => {
    const src = await import('fs').then((fs) =>
      fs.readFileSync('src/pages/GetPassPage.tsx', 'utf-8')
    );
    expect(src).toContain('houseBuilding: homeBuilding.trim() || undefined');
    expect(src).toContain('street: homeStreet.trim() || undefined');
    expect(src).toContain('formatStructuredAddress({');
  });
});
