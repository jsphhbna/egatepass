import { describe, it, expect } from 'vitest';
import {
  fetchPsgcRegions,
  fetchPsgcProvinces,
  fetchPsgcCities,
  fetchPsgcBarangays,
  resolvePostalCode,
  formatStructuredAddress,
} from '../src/lib/psgc';

describe('PSGC Client Library & Address Resolution Contract', () => {
  it('loads 18 PSA regions from reference dataset or bundle', async () => {
    const regions = await fetchPsgcRegions();
    expect(regions.length).toBe(18);

    const ncr = regions.find((r) => r.code === '1300000000');
    expect(ncr).toBeDefined();
    expect(ncr?.level).toBe('region');
    expect(ncr?.name).toBe('National Capital Region (NCR)');

    const region4a = regions.find((r) => r.code === '0400000000');
    expect(region4a).toBeDefined();
    expect(region4a?.name).toBe('Region IV-A (CALABARZON)');

    const nir = regions.find((r) => r.code === '1800000000');
    expect(nir).toBeDefined();
    expect(nir?.name).toBe('Negros Island Region (NIR)');
  });

  it('proves NCR has zero provinces and returns empty array', async () => {
    const provinces = await fetchPsgcProvinces('1300000000');
    expect(provinces.length).toBe(0);
  });

  it('loads provinces for CALABARZON (Region IV-A: Cavite, Laguna, Batangas, Rizal, Quezon)', async () => {
    const provinces = await fetchPsgcProvinces('0400000000');
    expect(provinces.length).toBeGreaterThanOrEqual(5);

    const cavite = provinces.find((p) => p.name === 'Cavite');
    expect(cavite).toBeDefined();
    expect(cavite?.level).toBe('province');
    expect(cavite?.parentCode).toBe('0400000000');
  });

  it('loads NCR cities directly under the NCR region code', async () => {
    const ncrCities = await fetchPsgcCities('1300000000');
    expect(ncrCities.length).toBeGreaterThanOrEqual(16);

    const manila = ncrCities.find((c) => c.code === '1380600000');
    expect(manila).toBeDefined();
    expect(manila?.name).toBe('City of Manila');
    expect(manila?.parentCode).toBe('1300000000');

    const qc = ncrCities.find((c) => c.name === 'Quezon City');
    expect(qc).toBeDefined();
    expect(qc?.parentCode).toBe('1300000000');
  });

  it('loads barangays under City of Manila including EARIST vicinity (Barangay 408)', async () => {
    const barangays = await fetchPsgcBarangays('1380600000');
    expect(barangays.length).toBeGreaterThan(0);

    const brgy408 = barangays.find((b) => b.code === '1380606014' || b.code === '1380600408');
    expect(brgy408).toBeDefined();
    expect(brgy408?.name).toContain('Barangay 408');
    expect(brgy408?.level).toBe('barangay');
    expect(brgy408?.parentCode).toBe('1380600000');
  });

  describe('Postal Code Resolution Confidence Contract', () => {
    it('resolves exact barangay match with 1008 for Barangay 408, Manila (EARIST)', async () => {
      const result = await resolvePostalCode('1380600000', '1380606014');
      expect(result.postalCode).toBe('1008');
      expect(result.mappingType).toBe('exact_barangay');
      expect(result.isAutoFilled).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it('resolves unique city match with 1550 for Mandaluyong City', async () => {
      const result = await resolvePostalCode('1380700000');
      expect(result.postalCode).toBe('1550');
      expect(result.mappingType).toBe('unique_city');
      expect(result.isAutoFilled).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it('resolves unique city match with 3000 for City of Malolos, Bulacan', async () => {
      const result = await resolvePostalCode('0314010000');
      expect(result.postalCode).toBe('3000');
      expect(result.mappingType).toBe('unique_city');
      expect(result.isAutoFilled).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it('resolves multi-code city requiring manual postal confirmation for City of Manila without exact barangay mapping (e.g. Barangay 856)', async () => {
      // Barangay 856 has no exact barangay mapping; City of Manila has 8 different postal delivery zones
      const result = await resolvePostalCode('1380600000', '1380612024');
      expect(result.postalCode).toBeNull();
      expect(result.mappingType).toBe('multi_code_city');
      expect(result.isAutoFilled).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.message).toContain('Postal code varies');
    });

    it('returns empty with manual confirmation for unmapped location', async () => {
      const result = await resolvePostalCode('9999990000', '9999999999');
      expect(result.postalCode).toBeNull();
      expect(result.mappingType).toBe('unmapped');
      expect(result.isAutoFilled).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
    });
  });

  describe('formatStructuredAddress Helper', () => {
    it('formats full structured address with building and street without province for NCR (omitting postal code)', () => {
      const formatted = formatStructuredAddress({
        regionName: 'National Capital Region',
        cityName: 'City of Manila',
        barangayName: 'Barangay 408',
        houseBuilding: 'Unit 4B, EARIST Dorm',
        street: 'Valencia St.',
        postalCode: '1008',
      });
      expect(formatted).toBe('Unit 4B, EARIST Dorm, Valencia St., Barangay 408, City of Manila, National Capital Region');
    });

    it('formats structured address with province for provincial locations (omitting postal code)', () => {
      const formatted = formatStructuredAddress({
        regionName: 'CALABARZON',
        provinceName: 'Cavite',
        cityName: 'City of Bacoor',
        barangayName: 'Habay I',
        houseBuilding: 'Block 5 Lot 12',
        street: 'Aguinaldo Highway',
        postalCode: '4102',
      });
      expect(formatted).toBe('Block 5 Lot 12, Aguinaldo Highway, Habay I, City of Bacoor, Cavite, CALABARZON');
    });

    it('formats cleanly even when building and street are omitted (omitting postal code)', () => {
      const formatted = formatStructuredAddress({
        regionName: 'National Capital Region',
        cityName: 'City of Manila',
        barangayName: 'Barangay 408',
        postalCode: '1008',
      });
      expect(formatted).toBe('Barangay 408, City of Manila, National Capital Region');
    });

    it('formats address without postal code even when postalCode is provided in input object', () => {
      const formatted = formatStructuredAddress({
        regionName: 'National Capital Region',
        cityName: 'City of Manila',
        barangayName: 'Barangay 856',
        houseBuilding: '123 Beata St.',
        street: 'Pandacan',
        postalCode: '1011',
      });
      expect(formatted).toBe('123 Beata St., Pandacan, Barangay 856, City of Manila, National Capital Region');
    });
  });
});
