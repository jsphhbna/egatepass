import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchPsgcRegions,
  fetchPsgcProvinces,
  fetchPsgcCities,
  fetchPsgcBarangays,
  formatStructuredAddress,
  clearPsgcCacheForTesting,
} from '../src/lib/psgc';
import * as psgcModule from '../src/lib/psgc';
import { parseAddressFromOcr } from '../src/lib/addressOcr';
import * as supabaseModule from '../src/lib/supabase';

describe('PSGC Client Library & Address Resolution Contract', () => {
  beforeEach(() => {
    clearPsgcCacheForTesting();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    clearPsgcCacheForTesting();
    vi.restoreAllMocks();
  });
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
    expect(qc?.code).toBe('1381300000');
    expect(qc?.parentCode).toBe('1300000000');

    const pasig = ncrCities.find((c) => c.name.toLowerCase().includes('pasig'));
    expect(pasig).toBeDefined();
    expect(pasig?.code).toBe('1381200000');

    const navotas = ncrCities.find((c) => c.name.toLowerCase().includes('navotas'));
    expect(navotas).toBeDefined();
    expect(navotas?.code).toBe('1380900000');
  });

  it('loads all 142 official PSA barangays under Quezon City (1381300000) from bundled reference when offline', async () => {
    // Simulate offline mode where Supabase cannot be reached
    vi.spyOn(supabaseModule, 'requirePortalSupabase').mockImplementation(() => {
      throw new Error('Offline network error');
    });

    const barangays = await fetchPsgcBarangays('1381300000');
    expect(barangays.length).toBe(142);

    const baesa = barangays.find((b) => b.code === '1381300005');
    expect(baesa).toBeDefined();
    expect(baesa?.name).toBe('Baesa');
    expect(baesa?.parentCode).toBe('1381300000');

    const alicia = barangays.find((b) => b.code === '1381300001');
    expect(alicia).toBeDefined();
    expect(alicia?.name).toBe('Alicia');

    const aurora = barangays.find((b) => b.code === '1381300004');
    expect(aurora).toBeDefined();
    expect(aurora?.name).toBe('Aurora');
  });

  it('queries Supabase psgc_locations first when online to guarantee complete data', async () => {
    const mockDbBarangays = [
      { psgc_code: '1381300001', parent_psgc_code: '1381300000', name: 'Alicia', level: 'barangay' },
      { psgc_code: '1381300005', parent_psgc_code: '1381300000', name: 'Baesa', level: 'barangay' },
    ];

    const mockSupabase = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'psgc_locations') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockResolvedValue({
              data: mockDbBarangays,
              error: null,
            }),
          };
        }
        return { select: vi.fn().mockReturnThis() };
      }),
    };

    vi.spyOn(supabaseModule, 'requirePortalSupabase').mockReturnValue(mockSupabase as any);

    const barangays = await fetchPsgcBarangays('1381300000');
    expect(barangays.length).toBe(2);
    expect(barangays[0].name).toBe('Alicia');
    expect(barangays[1].name).toBe('Baesa');
    expect(mockSupabase.from).toHaveBeenCalledWith('psgc_locations');
  });

  it('loads all 30 official PSA barangays under Pasig City (1381200000) when offline', async () => {
    vi.spyOn(supabaseModule, 'requirePortalSupabase').mockImplementation(() => {
      throw new Error('Offline network error');
    });
    const barangays = await fetchPsgcBarangays('1381200000');
    expect(barangays.length).toBe(30);
  });

  it('loads all 18 official PSA barangays under Navotas City (1380900000) when offline', async () => {
    vi.spyOn(supabaseModule, 'requirePortalSupabase').mockImplementation(() => {
      throw new Error('Offline network error');
    });
    const barangays = await fetchPsgcBarangays('1380900000');
    expect(barangays.length).toBe(18);
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

  describe('Postal Code Resolution Confidence Contract (Decommissioned)', () => {
    it('confirms resolvePostalCode is decommissioned from psgc library', () => {
      expect((psgcModule as any).resolvePostalCode).toBeUndefined();
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

  describe('Address OCR Suggestions Contract', () => {
    it('extracts structured address suggestions while strictly avoiding postal code collection', () => {
      const rawText = '123 Sampaloc St., Brgy. Baesa, Quezon City 1106';
      const result = parseAddressFromOcr(rawText);

      expect(result).toBeDefined();
      expect(result?.city).toBe('Quezon City');
      expect(result?.cityCode).toBe('1381300000');
      expect(result?.barangay).toBe('Baesa');
      expect(result?.street).toContain('Sampaloc St');
      // Strictly must NOT have postalCode
      expect((result as any).postalCode).toBeUndefined();
    });

    it('extracts Manila address suggestions without postal code', () => {
      const rawText = 'Unit 402, Valencia Street, Brgy. 408, Sampaloc, Manila 1008';
      const result = parseAddressFromOcr(rawText);

      expect(result).toBeDefined();
      expect(result?.city).toBe('City of Manila');
      expect(result?.cityCode).toBe('1380600000');
      expect(result?.barangay).toBe('408');
      expect((result as any).postalCode).toBeUndefined();
    });
  });
});
