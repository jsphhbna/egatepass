/**
 * server/lib/psgc-reference.ts
 *
 * Shared PSGC reference normalization, validation, and fail-closed integrity helpers
 * used across both returning visitor identification fallback and profile persistence.
 */

export type NormalizedPsgcLevel = 'region' | 'province' | 'city_municipality' | 'barangay' | 'unknown';

/**
 * Normalizes official PSGC geographic level designations.
 * Recognizes 'city', 'municipality', and 'city_municipality' as the standard
 * Philippine second-level administrative locality.
 */
export function normalizePsgcLevel(level?: string | null): NormalizedPsgcLevel {
  if (!level) return 'unknown';
  const clean = level.trim().toLowerCase();
  if (clean === 'region') return 'region';
  if (clean === 'province') return 'province';
  if (clean === 'city' || clean === 'municipality' || clean === 'city_municipality') {
    return 'city_municipality';
  }
  if (clean === 'barangay') return 'barangay';
  return 'unknown';
}

export interface PsgcExpectedReference {
  code: string;
  expectedLevel: NormalizedPsgcLevel;
  role: 'region' | 'province' | 'city_municipality' | 'barangay';
}

export interface PsgcLocationRecord {
  psgc_code?: string | null;
  code?: string | null;
  name?: string | null;
  level?: string | null;
}

export interface PsgcValidationSuccess {
  valid: true;
  regionName: string;
  provinceName: string | null;
  cityName: string;
  barangayName: string;
}

export interface PsgcValidationFailure {
  valid: false;
  error: string;
  details?: Record<string, any>;
}

export type PsgcValidationResult = PsgcValidationSuccess | PsgcValidationFailure;

/**
 * Constructs the explicit list of required PSGC reference records for a submitted address.
 * Province reference is only required when a non-empty province code is supplied.
 */
export function buildExpectedPsgcReferences(psgc: {
  regionCode: string;
  provinceCode?: string | null;
  cityCode: string;
  barangayCode: string;
}): PsgcExpectedReference[] {
  const refs: PsgcExpectedReference[] = [
    { code: psgc.regionCode.trim(), expectedLevel: 'region', role: 'region' },
  ];

  if (psgc.provinceCode && psgc.provinceCode.trim()) {
    refs.push({
      code: psgc.provinceCode.trim(),
      expectedLevel: 'province',
      role: 'province',
    });
  }

  refs.push(
    { code: psgc.cityCode.trim(), expectedLevel: 'city_municipality', role: 'city_municipality' },
    { code: psgc.barangayCode.trim(), expectedLevel: 'barangay', role: 'barangay' }
  );

  return refs;
}

/**
 * Validates fetched reference records against the expected reference list.
 * Fails closed if:
 * - Any expected record is missing
 * - Any record has a level mismatch
 * - Any locality name is empty or whitespace-only
 * - Conflicting/ambiguous records are detected for the same code
 * - An unrelated/mismatched code is provided
 */
export function validatePsgcReferences(
  expectedRefs: PsgcExpectedReference[],
  records: PsgcLocationRecord[] | null | undefined
): PsgcValidationResult {
  if (!records || records.length === 0) {
    return { valid: false, error: 'no_psgc_records_returned' };
  }

  // Index records by exact code and verify internal consistency
  const recordMap = new Map<string, { code: string; name: string; level: NormalizedPsgcLevel }>();

  for (const raw of records) {
    const rawCode = (raw.psgc_code || raw.code || '').trim();
    const rawName = (raw.name || '').trim();
    const normalizedLevel = normalizePsgcLevel(raw.level);

    if (!rawCode) {
      continue;
    }

    if (recordMap.has(rawCode)) {
      const existing = recordMap.get(rawCode)!;
      if (existing.name !== rawName || existing.level !== normalizedLevel) {
        return {
          valid: false,
          error: `ambiguous_psgc_records_for_code_${rawCode}`,
          details: { code: rawCode, existing, conflicting: { name: rawName, level: normalizedLevel } },
        };
      }
    } else {
      recordMap.set(rawCode, { code: rawCode, name: rawName, level: normalizedLevel });
    }
  }

  let regionName: string | null = null;
  let provinceName: string | null = null;
  let cityName: string | null = null;
  let barangayName: string | null = null;

  for (const expected of expectedRefs) {
    const matched = recordMap.get(expected.code);
    if (!matched) {
      return {
        valid: false,
        error: `missing_expected_psgc_record_${expected.role}_${expected.code}`,
        details: { expectedCode: expected.code, role: expected.role },
      };
    }

    if (matched.level !== expected.expectedLevel) {
      return {
        valid: false,
        error: `level_mismatch_for_${expected.role}_${expected.code}`,
        details: { expectedLevel: expected.expectedLevel, actualLevel: matched.level },
      };
    }

    if (!matched.name || matched.name.trim().length === 0) {
      return {
        valid: false,
        error: `empty_locality_name_for_${expected.role}_${expected.code}`,
        details: { code: expected.code, role: expected.role },
      };
    }

    if (expected.role === 'region') regionName = matched.name;
    else if (expected.role === 'province') provinceName = matched.name;
    else if (expected.role === 'city_municipality') cityName = matched.name;
    else if (expected.role === 'barangay') barangayName = matched.name;
  }

  if (!regionName || !cityName || !barangayName) {
    return { valid: false, error: 'incomplete_psgc_resolution' };
  }

  return {
    valid: true,
    regionName,
    provinceName,
    cityName,
    barangayName,
  };
}
