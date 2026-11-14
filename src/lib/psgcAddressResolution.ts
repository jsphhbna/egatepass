/**
 * src/lib/psgcAddressResolution.ts
 *
 * Pure, deterministic business logic helpers for PSGC address locality comparison
 * and administrative hierarchy consistency.
 *
 * Guarantees:
 * - Compares PSGC localities by standard administrative hierarchy codes.
 * - Respects absence of provinces in special administrative regions like NCR.
 * - Completely postal-code free.
 */

export interface PsgcLocationRef {
  code: string;
  name: string;
  [key: string]: any;
}

export interface SelectedPsgcAddressLike {
  version?: string;
  region: PsgcLocationRef;
  province?: PsgcLocationRef | null;
  city: PsgcLocationRef;
  barangay: PsgcLocationRef;
}

export interface LocalityComparisonTarget {
  region: PsgcLocationRef | null;
  province?: PsgcLocationRef | null;
  city: PsgcLocationRef | null;
  barangay: PsgcLocationRef | null;
}

/**
 * Compares two PSGC localities by their standard administrative hierarchy codes.
 * Returns true only if region, province (or absence thereof in NCR), city, and barangay match.
 */
export function isSameLocality(
  initial: SelectedPsgcAddressLike | null | undefined,
  current: LocalityComparisonTarget
): boolean {
  if (!initial || !current.region || !current.city || !current.barangay) return false;
  const sameRegion = initial.region.code === current.region.code;
  const sameProvince =
    (!initial.province && !current.province) ||
    initial.province?.code === current.province?.code;
  const sameCity = initial.city.code === current.city.code;
  const sameBarangay = initial.barangay.code === current.barangay.code;
  return sameRegion && sameProvince && sameCity && sameBarangay;
}
