/**
 * server/lib/psgc.ts
 *
 * Official Philippine Standard Geographic Code (PSGC) service and hierarchy validator.
 * Pinned dataset version: 2026-q3 (released October 12, 2026).
 */

import fs from 'node:fs';
import path from 'node:path';

export interface PsgcRegion {
  code: string;
  name: string;
  shortName: string;
  hasProvinces: boolean;
}

export interface PsgcProvince {
  code: string;
  regionCode: string;
  name: string;
}

export interface PsgcCity {
  code: string;
  regionCode: string;
  provinceCode: string | null;
  name: string;
  isCity: boolean;
  isHuc: boolean;
}

export interface PsgcBarangay {
  code: string;
  cityCode: string;
  name: string;
}

export interface PsgcValidationSuccess {
  valid: true;
  region: PsgcRegion;
  province: PsgcProvince | null;
  city: PsgcCity;
  barangay: PsgcBarangay;
  formattedLocation: string;
  version: string;
  psgcVersion: string;
}

export interface PsgcValidationFailure {
  valid: false;
  error: string;
  reason: string;
}

export type PsgcValidationResult = PsgcValidationSuccess | PsgcValidationFailure;

const DATA_DIR = path.resolve('server/data/psgc');

function loadJson<T>(filename: string): T {
  const filePath = path.join(DATA_DIR, filename);
  const content = fs.readFileSync(filePath, 'utf-8');
  return JSON.parse(content) as T;
}

let regionsCache: PsgcRegion[] | null = null;
let provincesCache: PsgcProvince[] | null = null;
let citiesCache: PsgcCity[] | null = null;
let barangaysCache: PsgcBarangay[] | null = null;

export function getPsgcRegions(): PsgcRegion[] {
  if (!regionsCache) regionsCache = loadJson<PsgcRegion[]>('regions.json');
  return regionsCache;
}

export function getPsgcProvinces(regionCode?: string): PsgcProvince[] {
  if (!provincesCache) provincesCache = loadJson<PsgcProvince[]>('provinces.json');
  if (regionCode) {
    return provincesCache.filter((p) => p.regionCode === regionCode);
  }
  return provincesCache;
}

export function getPsgcCities(regionCode?: string, provinceCode?: string | null): PsgcCity[] {
  if (!citiesCache) citiesCache = loadJson<PsgcCity[]>('cities.json');
  return citiesCache.filter((c) => {
    if (regionCode && c.regionCode !== regionCode) return false;
    if (provinceCode !== undefined) {
      if (provinceCode === null) {
        return c.provinceCode === null;
      }
      return c.provinceCode === provinceCode;
    }
    return true;
  });
}

export function getPsgcBarangays(cityCode: string): PsgcBarangay[] {
  if (!barangaysCache) barangaysCache = loadJson<PsgcBarangay[]>('barangays.json');
  return barangaysCache.filter((b) => b.cityCode === cityCode);
}

/**
 * Validates canonical PSGC administrative hierarchy.
 * Enforces:
 * 1. Region exists.
 * 2. If region has provinces, province must be valid and belong to region. If NCR, province must be empty.
 * 3. City/Municipality must belong to province (or region if province is null).
 * 4. Barangay must belong to city/municipality.
 */
export function validatePsgcHierarchy(
  regionCode: string,
  provinceCode: string | null | undefined,
  cityCode: string,
  barangayCode: string
): PsgcValidationResult {
  const regions = getPsgcRegions();
  const region = regions.find((r) => r.code === regionCode);
  if (!region) {
    return { valid: false, error: 'invalid_psgc_region', reason: 'invalid_psgc_region' };
  }

  let province: PsgcProvince | null = null;
  const normProvinceCode = (provinceCode || '').trim() || null;

  if (region.hasProvinces) {
    if (!normProvinceCode) {
      return { valid: false, error: 'psgc_province_required', reason: 'psgc_province_required' };
    }
    const provinces = getPsgcProvinces(regionCode);
    province = provinces.find((p) => p.code === normProvinceCode) || null;
    if (!province) {
      return { valid: false, error: 'invalid_psgc_province', reason: 'invalid_psgc_province' };
    }
  } else {
    // Region does not have provinces (e.g. NCR)
    if (normProvinceCode) {
      return { valid: false, error: 'psgc_province_prohibited_for_region', reason: 'psgc_province_prohibited_for_region' };
    }
  }

  const cities = getPsgcCities(regionCode, province ? province.code : null);
  const city = cities.find((c) => c.code === cityCode);
  if (!city) {
    return { valid: false, error: 'invalid_psgc_city', reason: 'invalid_psgc_city' };
  }

  const barangays = getPsgcBarangays(cityCode);
  const barangay = barangays.find((b) => b.code === barangayCode);
  if (!barangay) {
    return { valid: false, error: 'invalid_psgc_barangay', reason: 'invalid_psgc_barangay' };
  }

  const locationParts = [
    barangay.name,
    city.name,
    province ? province.name : null,
    region.name,
  ].filter(Boolean);

  return {
    valid: true,
    region,
    province,
    city,
    barangay,
    formattedLocation: locationParts.join(', '),
    version: '2026-q3',
    psgcVersion: '2026-Q3',
  };
}
