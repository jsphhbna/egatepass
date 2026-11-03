import { describe, it, expect } from 'vitest';
import {
  isCityOfManila,
  getManilaCongressionalDistricts,
  getManilaAdministrativeDistricts,
  lookupManilaDistrictForBarangay,
  filterManilaBarangays,
  extractBarangayNumber,
  MANILA_CITY_PSGC_CODE,
} from '../src/lib/manilaDistricts';
import type { PsgcLocation } from '../src/lib/psgc';

describe('Manila District & Area Locality Selector Contract', () => {
  describe('1. City of Manila Recognition', () => {
    it('identifies City of Manila by PSGC code 1380600000', () => {
      expect(isCityOfManila(MANILA_CITY_PSGC_CODE)).toBe(true);
      expect(isCityOfManila('1380600000')).toBe(true);
    });

    it('identifies City of Manila by name variants', () => {
      expect(isCityOfManila(null, 'City of Manila')).toBe(true);
      expect(isCityOfManila(undefined, 'Manila')).toBe(true);
      expect(isCityOfManila(undefined, 'Manila, City of')).toBe(true);
      expect(isCityOfManila(undefined, 'city of manila')).toBe(true);
    });

    it('returns false for non-Manila cities', () => {
      expect(isCityOfManila('1381200000', 'Quezon City')).toBe(false);
      expect(isCityOfManila('1380300000', 'Caloocan City')).toBe(false);
      expect(isCityOfManila('0314010000', 'City of Malolos')).toBe(false);
      expect(isCityOfManila(null, null)).toBe(false);
    });
  });

  describe('2. Congressional & Administrative District Structures', () => {
    it('returns all 6 official Manila congressional districts in order', () => {
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

    it('returns administrative districts filtered by congressional district', () => {
      const d1Areas = getManilaAdministrativeDistricts('District I');
      expect(d1Areas).toContain('Tondo I');

      const d2Areas = getManilaAdministrativeDistricts('District II');
      expect(d2Areas).toContain('Tondo II');

      const d3Areas = getManilaAdministrativeDistricts('District III');
      expect(d3Areas).toContain('Binondo');
      expect(d3Areas).toContain('Quiapo');
      expect(d3Areas).toContain('San Nicolas');
      expect(d3Areas).toContain('Santa Cruz');

      const d4Areas = getManilaAdministrativeDistricts('District IV');
      expect(d4Areas).toEqual(['Sampaloc']);

      const d5Areas = getManilaAdministrativeDistricts('District V');
      expect(d5Areas).toContain('Ermita');
      expect(d5Areas).toContain('Intramuros');
      expect(d5Areas).toContain('Malate');
      expect(d5Areas).toContain('Paco');
      expect(d5Areas).toContain('Port Area');
      expect(d5Areas).toContain('San Andres');

      const d6Areas = getManilaAdministrativeDistricts('District VI');
      expect(d6Areas).toContain('Paco');
      expect(d6Areas).toContain('Pandacan');
      expect(d6Areas).toContain('San Miguel');
      expect(d6Areas).toContain('Santa Ana');
      expect(d6Areas).toContain('Santa Mesa');
    });

    it('returns all unique administrative districts when no congressional district is provided', () => {
      const allAreas = getManilaAdministrativeDistricts();
      expect(allAreas.length).toBeGreaterThanOrEqual(14);
      expect(allAreas).toContain('Sampaloc');
      expect(allAreas).toContain('Binondo');
      expect(allAreas).toContain('Malate');
      expect(allAreas).toContain('Ermita');
      expect(allAreas).toContain('Santa Mesa');
      expect(allAreas).toContain('Pandacan');
    });
  });

  describe('3. Barangay Number Extraction & Resolution', () => {
    it('extracts barangay number from typical PSGC names and codes', () => {
      expect(extractBarangayNumber('Barangay 408 (Sampaloc / EARIST Nagtahan)')).toBe(408);
      expect(extractBarangayNumber('Barangay 287 (Binondo)')).toBe(287);
      expect(extractBarangayNumber('Brgy. 659 (Ermita)')).toBe(659);
      expect(extractBarangayNumber('Barangay 1')).toBe(1);
      expect(extractBarangayNumber('1380600408')).toBe(408);
      expect(extractBarangayNumber('1380600830')).toBe(830);
    });

    it('accurately resolves District and Area for EARIST Barangay 408', () => {
      const result = lookupManilaDistrictForBarangay({
        code: '1380600408',
        name: 'Barangay 408 (Sampaloc / EARIST Nagtahan)',
      });
      expect(result).toEqual({
        congressionalDistrict: 'District IV',
        administrativeDistrict: 'Sampaloc',
      });
    });

    it('accurately resolves Binondo Barangay 287', () => {
      const result = lookupManilaDistrictForBarangay({
        code: '1380600287',
        name: 'Barangay 287 (Binondo)',
      });
      expect(result).toEqual({
        congressionalDistrict: 'District III',
        administrativeDistrict: 'Binondo',
      });
    });

    it('accurately resolves Ermita Barangay 659', () => {
      const result = lookupManilaDistrictForBarangay({
        code: '1380600659',
        name: 'Barangay 659 (Ermita)',
      });
      expect(result).toEqual({
        congressionalDistrict: 'District V',
        administrativeDistrict: 'Ermita',
      });
    });

    it('accurately resolves Pandacan Barangay 830', () => {
      const result = lookupManilaDistrictForBarangay({
        code: '1380600830',
        name: 'Barangay 830 (Pandacan)',
      });
      expect(result).toEqual({
        congressionalDistrict: 'District VI',
        administrativeDistrict: 'Pandacan',
      });
    });

    it('accurately resolves Santa Mesa Barangay 587', () => {
      const result = lookupManilaDistrictForBarangay({
        code: '1380600587',
        name: 'Barangay 587 (Santa Mesa)',
      });
      expect(result).toEqual({
        congressionalDistrict: 'District VI',
        administrativeDistrict: 'Santa Mesa',
      });
    });

    it('accurately resolves Santa Cruz Barangay 306', () => {
      const result = lookupManilaDistrictForBarangay({
        code: '1380600306',
        name: 'Barangay 306 (Santa Cruz)',
      });
      expect(result).toEqual({
        congressionalDistrict: 'District III',
        administrativeDistrict: 'Santa Cruz',
      });
    });

    it('accurately resolves Paco Barangay 821 to District VI', () => {
      const result = lookupManilaDistrictForBarangay({
        code: '1380600821',
        name: 'Barangay 821 (Paco)',
      });
      expect(result).toEqual({
        congressionalDistrict: 'District VI',
        administrativeDistrict: 'Paco',
      });
    });
  });

  describe('4. Manila Barangay Filtering Hierarchy', () => {
    const sampleBarangays: PsgcLocation[] = [
      { code: '1380600408', parentCode: '1380600000', name: 'Barangay 408 (Sampaloc / EARIST Nagtahan)', level: 'barangay' },
      { code: '1380600409', parentCode: '1380600000', name: 'Barangay 409 (Sampaloc)', level: 'barangay' },
      { code: '1380600287', parentCode: '1380600000', name: 'Barangay 287 (Binondo)', level: 'barangay' },
      { code: '1380600306', parentCode: '1380600000', name: 'Barangay 306 (Santa Cruz)', level: 'barangay' },
      { code: '1380600659', parentCode: '1380600000', name: 'Barangay 659 (Ermita)', level: 'barangay' },
      { code: '1380600696', parentCode: '1380600000', name: 'Barangay 696 (Malate)', level: 'barangay' },
      { code: '1380600830', parentCode: '1380600000', name: 'Barangay 830 (Pandacan)', level: 'barangay' },
      { code: '1380600587', parentCode: '1380600000', name: 'Barangay 587 (Santa Mesa)', level: 'barangay' },
    ];

    it('returns all barangays when no filter is applied', () => {
      const res = filterManilaBarangays(sampleBarangays, {});
      expect(res.length).toBe(sampleBarangays.length);
    });

    it('filters barangays by Congressional District IV (Sampaloc)', () => {
      const res = filterManilaBarangays(sampleBarangays, { congressionalDistrict: 'District IV' });
      expect(res.length).toBe(2);
      expect(res.map((b) => b.code)).toEqual(['1380600408', '1380600409']);
    });

    it('filters barangays by Congressional District III (Binondo & Santa Cruz)', () => {
      const res = filterManilaBarangays(sampleBarangays, { congressionalDistrict: 'District III' });
      expect(res.length).toBe(2);
      expect(res.map((b) => b.code)).toEqual(['1380600287', '1380600306']);
    });

    it('filters barangays by Administrative Area Binondo', () => {
      const res = filterManilaBarangays(sampleBarangays, { administrativeDistrict: 'Binondo' });
      expect(res.length).toBe(1);
      expect(res[0]?.code).toBe('1380600287');
    });

    it('filters barangays by both Congressional District and Administrative Area', () => {
      const res = filterManilaBarangays(sampleBarangays, {
        congressionalDistrict: 'District VI',
        administrativeDistrict: 'Pandacan',
      });
      expect(res.length).toBe(1);
      expect(res[0]?.code).toBe('1380600830');
    });

    it('returns empty list when district and area do not intersect', () => {
      const res = filterManilaBarangays(sampleBarangays, {
        congressionalDistrict: 'District I',
        administrativeDistrict: 'Sampaloc', // Sampaloc is District IV, not District I
      });
      expect(res.length).toBe(0);
    });
  });
});
