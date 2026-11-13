import { describe, it, expect } from 'vitest';
import {
  isCityOfManila,
  getManilaCongressionalDistricts,
  getManilaAdministrativeDistricts,
  lookupManilaDistrictForBarangay,
  filterManilaBarangays,
  extractBarangayNumber,
  MANILA_CONGRESSIONAL_DISTRICTS,
} from '@/lib/manilaDistricts';
import { MANILA_BARANGAY_DIRECTORY } from '@/lib/manilaBarangayDirectory';
import { formatStructuredAddress, type PsgcLocation } from '@/lib/psgc';
import { hydrateReturningAddress } from '@/lib/returningAddressHydration';

describe('City of Manila 5-Level Geographic Hierarchy Contract', () => {
  it('correctly identifies City of Manila by code or name variations', () => {
    expect(isCityOfManila('1380600000', null)).toBe(true);
    expect(isCityOfManila(null, 'City of Manila')).toBe(true);
    expect(isCityOfManila(null, 'Manila')).toBe(true);
    expect(isCityOfManila(null, 'Manila, City of')).toBe(true);
    expect(isCityOfManila('1380700000', 'Mandaluyong City')).toBe(false);
  });

  it('provides all 6 Congressional Districts in canonical order', () => {
    const districts = getManilaCongressionalDistricts();
    expect(districts).toEqual([
      'District I',
      'District II',
      'District III',
      'District IV',
      'District V',
      'District VI',
    ]);
  });

  it('provides correct dependent administrative districts per Congressional District', () => {
    // District I: Tondo I
    expect(getManilaAdministrativeDistricts('District I')).toEqual(['Tondo I']);

    // District II: Tondo II
    expect(getManilaAdministrativeDistricts('District II')).toEqual(['Tondo II']);

    // District III: Binondo, Quiapo, San Nicolas, Santa Cruz
    expect(getManilaAdministrativeDistricts('District III')).toEqual([
      'Binondo',
      'Quiapo',
      'San Nicolas',
      'Santa Cruz',
    ]);

    // District IV: Sampaloc
    expect(getManilaAdministrativeDistricts('District IV')).toEqual(['Sampaloc']);

    // District V: Ermita, Intramuros, Malate, Paco, Port Area, San Andres
    expect(getManilaAdministrativeDistricts('District V')).toEqual([
      'Ermita',
      'Intramuros',
      'Malate',
      'Paco',
      'Port Area',
      'San Andres',
    ]);

    // District VI: Paco, Pandacan, San Miguel, Santa Ana, Santa Mesa
    expect(getManilaAdministrativeDistricts('District VI')).toEqual([
      'Paco',
      'Pandacan',
      'San Miguel',
      'Santa Ana',
      'Santa Mesa',
    ]);
  });

  it('allocates barangays to correct districts and areas via authoritative directory', () => {
    // Barangay 408 (Sampaloc / EARIST) -> District IV
    const bgy408 = lookupManilaDistrictForBarangay({ code: '1380606014', name: 'Barangay 408' });
    expect(bgy408).toEqual({
      congressionalDistrict: 'District IV',
      administrativeDistrict: 'Sampaloc',
    });

    // Paco division:
    // Barangay 687 (District V)
    const bgy687 = lookupManilaDistrictForBarangay({ code: '1380611049', name: 'Barangay 687' });
    expect(bgy687).toEqual({
      congressionalDistrict: 'District V',
      administrativeDistrict: 'Paco',
    });

    // Barangay 686 (District VI)
    const bgy686 = lookupManilaDistrictForBarangay({ name: 'Barangay 686' });
    expect(bgy686).toEqual({
      congressionalDistrict: 'District VI',
      administrativeDistrict: 'Paco',
    });

    // Barangay 821 (District VI)
    const bgy821 = lookupManilaDistrictForBarangay({ code: '1380611036', name: 'Barangay 821' });
    expect(bgy821).toEqual({
      congressionalDistrict: 'District VI',
      administrativeDistrict: 'Paco',
    });

    // San Andres boundary:
    // Barangay 819 (District V)
    const bgy819 = lookupManilaDistrictForBarangay({ code: '1380611034', name: 'Barangay 819' });
    expect(bgy819).toEqual({
      congressionalDistrict: 'District V',
      administrativeDistrict: 'San Andres',
    });

    // Barangay 820 (District V)
    const bgy820 = lookupManilaDistrictForBarangay({ code: '1380611035', name: 'Barangay 820' });
    expect(bgy820).toEqual({
      congressionalDistrict: 'District V',
      administrativeDistrict: 'San Andres',
    });

    // Santa Mesa (District VI)
    const bgy587 = lookupManilaDistrictForBarangay({ code: '1380606193', name: 'Barangay 587' });
    expect(bgy587).toEqual({
      congressionalDistrict: 'District VI',
      administrativeDistrict: 'Santa Mesa',
    });

    // Binondo (District III)
    const bgy287 = lookupManilaDistrictForBarangay({ code: '1380602001', name: 'Barangay 287' });
    expect(bgy287).toEqual({
      congressionalDistrict: 'District III',
      administrativeDistrict: 'Binondo',
    });
  });

  it('filters Manila barangays strictly by District and Area', () => {
    const mockBarangays: PsgcLocation[] = [
      { code: '1380606014', name: 'Barangay 408', level: 'barangay', parentCode: '1380600000' },
      { code: '1380606193', name: 'Barangay 587', level: 'barangay', parentCode: '1380600000' },
      { code: '1380611036', name: 'Barangay 821', level: 'barangay', parentCode: '1380600000' },
      { code: '1380611049', name: 'Barangay 687', level: 'barangay', parentCode: '1380600000' },
      { code: '1380611034', name: 'Barangay 819', level: 'barangay', parentCode: '1380600000' },
    ];

    // Filter by District IV
    const dist4 = filterManilaBarangays(mockBarangays, { congressionalDistrict: 'District IV' });
    expect(dist4.map((b) => b.code)).toEqual(['1380606014']);

    // Filter by District V and Paco
    const dist5Paco = filterManilaBarangays(mockBarangays, {
      congressionalDistrict: 'District V',
      administrativeDistrict: 'Paco',
    });
    expect(dist5Paco.map((b) => b.code)).toEqual(['1380611049']);

    // Filter by District VI and Paco
    const dist6Paco = filterManilaBarangays(mockBarangays, {
      congressionalDistrict: 'District VI',
      administrativeDistrict: 'Paco',
    });
    expect(dist6Paco.map((b) => b.code)).toEqual(['1380611036']);
  });

  it('verifies that the pre-compiled directory covers 897 official PSA Manila barangays', () => {
    const codes = Object.keys(MANILA_BARANGAY_DIRECTORY);
    // 897 official + 25 legacy aliases = 922 entries in directory
    expect(codes.length).toBeGreaterThanOrEqual(897);
  });
});

describe('Returning Visitor Address Hydration & Round-Trip Contract', () => {
  it('hydrates returning visitor address with full PSGC metadata and building/street', () => {
    const mockProfile = {
      id: 'profile-123',
      firstName: 'Juan',
      lastName: 'Dela Cruz',
      contactNumber: '+639171234567',
      homeAddress: 'Unit 401, Nagtahan St., Barangay 408, City of Manila, National Capital Region (NCR), Postal Code 1008',
      psgc: {
        version: '2026-q3',
        region: { code: '1300000000', name: 'National Capital Region (NCR)' },
        province: null,
        city: { code: '1380600000', name: 'City of Manila' },
        barangay: { code: '1380606014', name: 'Barangay 408' },
        houseBuilding: 'Unit 401',
        street: 'Nagtahan St.',
        postalCode: '1008',
      },
    };

    const hydrated = hydrateReturningAddress(mockProfile);
    expect(hydrated.selectedPsgc).toBeDefined();
    expect(hydrated.selectedPsgc?.city.code).toBe('1380600000');
    expect(hydrated.selectedPsgc?.barangay.code).toBe('1380606014');
    expect(hydrated.homeBuilding).toBe('Unit 401');
    expect(hydrated.homeStreet).toBe('Nagtahan St.');
    expect(hydrated.postalCode).toBe('');

    // Canonical formatted string representation matches expected review output
    const formatted = formatStructuredAddress({
      regionName: hydrated.selectedPsgc!.region.name,
      provinceName: hydrated.selectedPsgc!.province?.name,
      cityName: hydrated.selectedPsgc!.city.name,
      barangayName: hydrated.selectedPsgc!.barangay.name,
      houseBuilding: hydrated.homeBuilding,
      street: hydrated.homeStreet,
      postalCode: hydrated.postalCode,
    });

    expect(formatted).toBe(
      'Unit 401, Nagtahan St., Barangay 408, City of Manila, National Capital Region (NCR)'
    );
  });
});
