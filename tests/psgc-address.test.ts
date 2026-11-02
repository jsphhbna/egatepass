import { describe, it, expect } from 'vitest';
import {
  getPsgcRegions,
  getPsgcProvinces,
  getPsgcCities,
  getPsgcBarangays,
  validatePsgcHierarchy,
} from '../server/lib/psgc.js';
import addressPsgcHandler from '../server/routes/address/psgc.js';

describe('PSGC Administrative Address Hierarchy & Verification', () => {
  describe('1. Dataset Structure & Extraction (PSA PSGC Q3 2026)', () => {
    it('loads 17 official Philippine regions', () => {
      const regions = getPsgcRegions();
      expect(regions.length).toBe(17);

      const ncr = regions.find((r) => r.code === '1300000000');
      expect(ncr).toBeDefined();
      expect(ncr?.name).toContain('National Capital Region');

      const r3 = regions.find((r) => r.code === '0300000000');
      expect(r3).toBeDefined();
      expect(r3?.name).toContain('Central Luzon');
    });

    it('returns empty provinces for NCR (provinces omitted)', () => {
      const ncrProvinces = getPsgcProvinces('1300000000');
      expect(ncrProvinces.length).toBe(0);
    });

    it('returns provinces for regions with provincial divisions (e.g., Region III Central Luzon)', () => {
      const r3Provinces = getPsgcProvinces('0300000000');
      expect(r3Provinces.length).toBeGreaterThanOrEqual(7); // Aurora, Bataan, Bulacan, Nueva Ecija, Pampanga, Tarlac, Zambales
      const bulacan = r3Provinces.find((p) => p.name.toLowerCase().includes('bulacan'));
      expect(bulacan).toBeDefined();
    });

    it('returns cities and municipalities for NCR directly under region code', () => {
      const ncrCities = getPsgcCities('1300000000');
      expect(ncrCities.length).toBeGreaterThanOrEqual(16);

      const manila = ncrCities.find((c) => c.name.toLowerCase().includes('city of manila') || c.name.toLowerCase() === 'manila');
      expect(manila).toBeDefined();

      const makati = ncrCities.find((c) => c.name.toLowerCase().includes('makati'));
      expect(makati).toBeDefined();
    });

    it('returns barangays for a given city code', () => {
      // Find City of Manila or Makati code
      const ncrCities = getPsgcCities('1300000000');
      const makati = ncrCities.find((c) => c.name.toLowerCase().includes('makati'));
      expect(makati).toBeDefined();

      if (makati) {
        const barangays = getPsgcBarangays(makati.code);
        expect(barangays.length).toBeGreaterThan(0);
        const belAir = barangays.find((b) => b.name.toLowerCase().includes('bel-air'));
        expect(belAir).toBeDefined();
      }
    });
  });

  describe('2. PSGC Hierarchy Validation', () => {
    it('validates a valid NCR city and barangay without province', () => {
      const ncrCities = getPsgcCities('1300000000');
      const makati = ncrCities.find((c) => c.name.toLowerCase().includes('makati'))!;
      const barangays = getPsgcBarangays(makati.code);
      const bg = barangays[0]!;

      const result = validatePsgcHierarchy('1300000000', undefined, makati.code, bg.code);
      expect(result.valid).toBe(true);
      if (result.valid) {
        expect(result.region.code).toBe('1300000000');
        expect(result.province).toBeNull();
        expect(result.city.code).toBe(makati.code);
        expect(result.barangay?.code).toBe(bg.code);
        expect(result.psgcVersion).toBe('2026-Q3');
      }
    });

    it('rejects an invalid region code', () => {
      const result = validatePsgcHierarchy('9999999999', undefined, '1339000000', '1339000001');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe('invalid_psgc_region');
      }
    });

    it('rejects a province provided for NCR', () => {
      const result = validatePsgcHierarchy('1300000000', '0314000000', '1339000000', '1339000001');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe('psgc_province_prohibited_for_region');
      }
    });

    it('rejects a city that does not belong to the selected region/province', () => {
      // Region 3 code with Makati city code
      const result = validatePsgcHierarchy('0300000000', '0314000000', '1339000000', '1339000001');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe('invalid_psgc_city');
      }
    });

    it('rejects an invalid barangay for the given city', () => {
      const ncrCities = getPsgcCities('1300000000');
      const makati = ncrCities.find((c) => c.name.toLowerCase().includes('makati'))!;
      const result = validatePsgcHierarchy('1300000000', undefined, makati.code, '9999999999');
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.error).toBe('invalid_psgc_barangay');
      }
    });
  });

  describe('3. PSGC REST Route Handler Contract', () => {
    it('returns regions on level=regions', async () => {
      const req = new Request('http://localhost/api/passes/address/psgc?level=regions');
      const res = await addressPsgcHandler.fetch(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBe(17);
      expect(res.headers.get('Cache-Control')).toContain('max-age=86400');
    });

    it('returns provinces on level=provinces with valid regionCode', async () => {
      const req = new Request('http://localhost/api/passes/address/psgc?level=provinces&regionCode=0300000000');
      const res = await addressPsgcHandler.fetch(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
    });

    it('returns cities on level=cities with regionCode', async () => {
      const req = new Request('http://localhost/api/passes/address/psgc?level=cities&regionCode=1300000000');
      const res = await addressPsgcHandler.fetch(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(Array.isArray(data.data)).toBe(true);
      expect(data.data.length).toBeGreaterThan(0);
    });

    it('rejects missing level or invalid level with 400', async () => {
      const req = new Request('http://localhost/api/passes/address/psgc?level=unknown');
      const res = await addressPsgcHandler.fetch(req);
      expect(res.status).toBe(400);
    });
  });
});
