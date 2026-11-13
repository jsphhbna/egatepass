/**
 * src/lib/psgc.ts
 *
 * Official Philippine Standard Geographic Code (PSGC) and PHLPost Postal Code client library.
 * Provides caching, cascading hierarchy traversal, and postal code resolution.
 */

import { requirePortalSupabase } from './supabase';
import regionsData from '../../data/reference/psgc/regions.json';
import provincesData from '../../data/reference/psgc/provinces.json';
import citiesData from '../../data/reference/psgc/cities.json';
import barangaysData from '../../data/reference/psgc/barangays.json';
import postalData from '../../data/reference/postal/postal_codes.json';

export interface PsgcLocation {
  code: string;
  parentCode: string | null;
  name: string;
  level: 'region' | 'province' | 'city' | 'municipality' | 'barangay';
  hasProvinces?: boolean;
  isCity?: boolean;
  isHuc?: boolean;
}

export interface PostalResolution {
  postalCode: string | null;
  mappingType: 'exact_barangay' | 'unique_city' | 'multi_code_city' | 'unmapped' | 'ambiguous' | 'service_unavailable' | 'unknown';
  isAutoFilled: boolean;
  requiresConfirmation: boolean;
  message?: string;
}

export interface StructuredAddress {
  version: string;
  region: { code: string; name: string };
  province: { code: string; name: string } | null;
  city: { code: string; name: string };
  barangay: { code: string; name: string };
  houseBuilding?: string;
  street?: string;
  postalCode?: string;
  postalCodeSource?: string;
  composedAddress: string;
}

const memoryCache = new Map<string, PsgcLocation[]>();

export function clearPsgcCacheForTesting(): void {
  memoryCache.clear();
}

/**
 * Fetch all 18 official Philippine regions.
 */
export async function fetchPsgcRegions(): Promise<PsgcLocation[]> {
  const cacheKey = 'regions';
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey)!;
  }

  // 1. Primary: Bundled reference data (0 ms in-memory response)
  if (Array.isArray(regionsData) && regionsData.length > 0) {
    const bundled: PsgcLocation[] = (regionsData as any[]).map((r) => ({
      code: r.code,
      parentCode: null,
      name: r.name,
      level: 'region',
      hasProvinces: r.hasProvinces ?? (r.code !== '1300000000'),
    }));
    memoryCache.set(cacheKey, bundled);
    return bundled;
  }

  try {
    const supabase = requirePortalSupabase();
    const { data, error } = await supabase
      .from('psgc_locations')
      .select('psgc_code, parent_psgc_code, name, level')
      .eq('level', 'region')
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (!error && data && data.length > 0) {
      const mapped: PsgcLocation[] = data.map((d: any) => ({
        code: d.psgc_code,
        parentCode: d.parent_psgc_code,
        name: d.name,
        level: 'region',
        hasProvinces: d.psgc_code !== '1300000000', // NCR has no provinces
      }));
      memoryCache.set(cacheKey, mapped);
      return mapped;
    }
  } catch {
    // Fall back
  }

  return [];
}

/**
 * Fetch provinces for a given region.
 * Returns empty array if region has no provinces (e.g. NCR).
 */
export async function fetchPsgcProvinces(regionCode: string): Promise<PsgcLocation[]> {
  if (regionCode === '1300000000') {
    return []; // NCR has NO provinces
  }

  const cacheKey = `provinces_${regionCode}`;
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey)!;
  }

  // 1. Primary: Bundled reference data (0 ms in-memory response)
  if (Array.isArray(provincesData)) {
    const bundled: PsgcLocation[] = (provincesData as any[])
      .filter((p) => p.regionCode === regionCode)
      .map((p) => ({
        code: p.code,
        parentCode: p.regionCode,
        name: p.name,
        level: 'province',
      }));
    if (bundled.length > 0) {
      memoryCache.set(cacheKey, bundled);
      return bundled;
    }
  }

  try {
    const supabase = requirePortalSupabase();
    const { data, error } = await supabase
      .from('psgc_locations')
      .select('psgc_code, parent_psgc_code, name, level')
      .eq('parent_psgc_code', regionCode)
      .eq('level', 'province')
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (!error && data && data.length > 0) {
      const mapped: PsgcLocation[] = data.map((d: any) => ({
        code: d.psgc_code,
        parentCode: d.parent_psgc_code,
        name: d.name,
        level: 'province',
      }));
      memoryCache.set(cacheKey, mapped);
      return mapped;
    }
  } catch {
    // Fall back
  }

  return [];
}

/**
 * Fetch cities and municipalities for a given province (or region if region has no provinces like NCR).
 */
export async function fetchPsgcCities(parentCode: string): Promise<PsgcLocation[]> {
  const cacheKey = `cities_${parentCode}`;
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey)!;
  }

  // 1. Primary: Bundled reference data (0 ms in-memory response)
  if (Array.isArray(citiesData)) {
    const bundled: PsgcLocation[] = (citiesData as any[])
      .filter((c) => (c.provinceCode || c.regionCode) === parentCode)
      .map((c) => ({
        code: c.code,
        parentCode: c.provinceCode || c.regionCode,
        name: c.name,
        level: c.isCity ? 'city' : 'municipality',
        isCity: c.isCity,
        isHuc: c.isHuc,
      }));
    if (bundled.length > 0) {
      memoryCache.set(cacheKey, bundled);
      return bundled;
    }
  }

  try {
    const supabase = requirePortalSupabase();
    const { data, error } = await supabase
      .from('psgc_locations')
      .select('psgc_code, parent_psgc_code, name, level, location_type')
      .eq('parent_psgc_code', parentCode)
      .in('level', ['city', 'municipality'])
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (!error && data && data.length > 0) {
      const mapped: PsgcLocation[] = data.map((d: any) => ({
        code: d.psgc_code,
        parentCode: d.parent_psgc_code,
        name: d.name,
        level: d.level,
        isCity: d.level === 'city',
        isHuc: d.location_type === 'huc',
      }));
      memoryCache.set(cacheKey, mapped);
      return mapped;
    }
  } catch {
    // Fall back
  }

  return [];
}

/**
 * Fetch barangays for a given city or municipality.
 * Queries Supabase psgc_locations first when online to guarantee complete data
 * (never treating a partial bundled list as complete), falling back to bundle if offline.
 */
export async function fetchPsgcBarangays(cityCode: string): Promise<PsgcLocation[]> {
  const cacheKey = `barangays_${cityCode}`;
  if (memoryCache.has(cacheKey)) {
    return memoryCache.get(cacheKey)!;
  }

  // 1. Primary: Live Supabase psgc_locations when online
  try {
    const supabase = requirePortalSupabase();
    const { data, error } = await supabase
      .from('psgc_locations')
      .select('psgc_code, parent_psgc_code, name, level')
      .eq('parent_psgc_code', cityCode)
      .eq('level', 'barangay')
      .eq('is_active', true)
      .order('name', { ascending: true });

    if (!error && data && data.length > 0) {
      const mapped: PsgcLocation[] = data.map((d: any) => ({
        code: d.psgc_code,
        parentCode: d.parent_psgc_code,
        name: d.name,
        level: 'barangay',
      }));
      memoryCache.set(cacheKey, mapped);
      return mapped;
    }
  } catch {
    // Supabase unavailable / offline -> fall back to bundled dataset
  }

  // 2. Fallback: Bundled reference data (offline resilience)
  if (Array.isArray(barangaysData)) {
    const bundled: PsgcLocation[] = (barangaysData as any[])
      .filter((b) => b.cityCode === cityCode)
      .map((b) => ({
        code: b.code,
        parentCode: b.cityCode,
        name: b.name,
        level: 'barangay',
      }));
    if (bundled.length > 0) {
      memoryCache.set(cacheKey, bundled);
      return bundled;
    }
  }

  return [];
}

/**
 * Resolve PHLPost postal code for the selected locality and barangay.
 * Follows strict match confidence rules:
 * 1. Exact barangay match -> auto-filled.
 * 2. Unique city match -> auto-filled.
 * 3. Multi-code city -> ambiguous; prompts user confirmation/entry.
 * 4. Unmapped -> prompt manual entry.
 */
export async function resolvePostalCode(
  cityCode: string,
  barangayCode?: string
): Promise<PostalResolution> {
  let supabase: any = null;
  try {
    supabase = requirePortalSupabase();
  } catch {
    supabase = null;
  }

  let dbLookupFailed = false;

  if (supabase) {
    try {
      // 1. Check exact barangay match
      if (barangayCode) {
        const { data: bgyMatch, error: bgyError } = await supabase
          .from('postal_code_reference')
          .select('postal_code, mapping_type')
          .eq('barangay_psgc_code', barangayCode)
          .eq('is_active', true)
          .limit(1)
          .maybeSingle();

        if (bgyError) {
          dbLookupFailed = true;
        } else if (bgyMatch) {
          return {
            postalCode: bgyMatch.postal_code,
            mappingType: 'exact_barangay',
            isAutoFilled: true,
            requiresConfirmation: false,
          };
        }
      }

      // 2. Check unique city match
      const { data: cityMatches, error: cityError } = await supabase
        .from('postal_code_reference')
        .select('postal_code, mapping_type')
        .eq('psgc_locality_code', cityCode)
        .eq('is_active', true);

      if (cityError) {
        dbLookupFailed = true;
      } else if (cityMatches && cityMatches.length > 0) {
        const uniqueCodes = Array.from(new Set(cityMatches.map((m: any) => m.postal_code as string))) as string[];
        if (uniqueCodes.length === 1 && cityMatches[0]?.mapping_type === 'unique_city') {
          return {
            postalCode: uniqueCodes[0] ?? null,
            mappingType: 'unique_city',
            isAutoFilled: true,
            requiresConfirmation: false,
          };
        } else if (uniqueCodes.length > 1) {
          return {
            postalCode: null,
            mappingType: 'multi_code_city',
            isAutoFilled: false,
            requiresConfirmation: true,
            message: 'Postal code varies by delivery area. Please confirm your applicable postal code.',
          };
        }
      }
    } catch {
      dbLookupFailed = true;
    }
  }

  if (dbLookupFailed) {
    return {
      postalCode: null,
      mappingType: 'service_unavailable',
      isAutoFilled: false,
      requiresConfirmation: true,
      message: 'Postal lookup service could not be reached. Please enter your 4-digit postal code manually.',
    };
  }

  // Fallback resolution using bundled dataset
  // Legacy synthetic barangay codes (e.g. 1380600%) cannot produce automatic matches
  const isLegacySyntheticBarangay = Boolean(barangayCode && barangayCode.startsWith('1380600'));

  if (barangayCode && !isLegacySyntheticBarangay) {
    const bgyMatch = (postalData as any[]).find(
      (p) => p.barangayPsgcCode === barangayCode && p.psgcLocalityCode === cityCode
    );
    if (bgyMatch) {
      return {
        postalCode: bgyMatch.postalCode,
        mappingType: 'exact_barangay',
        isAutoFilled: true,
        requiresConfirmation: false,
      };
    }
  }

  const cityMatches = (postalData as any[]).filter(
    (p) => p.psgcLocalityCode === cityCode
  );

  if (cityMatches.length > 0) {
    const uniqueCodes = Array.from(new Set(cityMatches.map((m) => m.postalCode)));
    if (uniqueCodes.length === 1 && cityMatches[0]?.mappingType === 'unique_city') {
      return {
        postalCode: (uniqueCodes[0] as string) ?? null,
        mappingType: 'unique_city',
        isAutoFilled: true,
        requiresConfirmation: false,
      };
    } else if (uniqueCodes.length > 1) {
      return {
        postalCode: null,
        mappingType: 'multi_code_city',
        isAutoFilled: false,
        requiresConfirmation: true,
        message: 'Postal code varies by delivery area. Please confirm your applicable postal code.',
      };
    }
  }

  return {
    postalCode: null,
    mappingType: 'unmapped',
    isAutoFilled: false,
    requiresConfirmation: true,
    message: 'No automatic postal mapping found. Please enter your 4-digit postal code.',
  };
}

/**
 * Format a human-readable composed address from structured PSGC fields.
 */
export function formatStructuredAddress(addr: {
  regionName: string;
  provinceName?: string | null;
  cityName: string;
  barangayName: string;
  houseBuilding?: string | null;
  street?: string | null;
  postalCode?: string | null;
}): string {
  const parts: string[] = [];
  if (addr.houseBuilding?.trim()) parts.push(addr.houseBuilding.trim());
  if (addr.street?.trim()) parts.push(addr.street.trim());
  if (addr.barangayName?.trim()) parts.push(addr.barangayName.trim());
  if (addr.cityName?.trim()) parts.push(addr.cityName.trim());
  if (addr.provinceName?.trim()) parts.push(addr.provinceName.trim());
  if (addr.regionName?.trim()) parts.push(addr.regionName.trim());
  return parts.join(', ');
}
