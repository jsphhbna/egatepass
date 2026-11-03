/**
 * src/lib/psgcAddressResolution.ts
 *
 * Pure, deterministic business logic helpers for PSGC address and postal code
 * resolution, locality comparison, and state synchronization.
 *
 * Guaranteed invariants:
 * 1. When a user or returning visitor re-selects the same locality, their existing
 *    postal code state (including manual overrides or cleared values) is strictly preserved
 *    over an automatic lookup overwrite.
 * 2. When a user selects a different locality, the previous locality's postal state
 *    is discarded and fresh resolution (auto-fill or manual prompt) is applied.
 * 3. Provenance is always honest: 'PHLPost' is only assigned when the code was
 *    derived directly from official reference data without deviation; otherwise 'manual'.
 */

import type { PsgcLocation, PostalResolution } from './psgc';

export interface PostalResolutionMetadata {
  postalCode?: string | null;
  isAutoFilled?: boolean;
  requiresConfirmation?: boolean;
  mappingType?: 'exact_barangay' | 'city_default' | 'shared_zone' | 'unmapped' | 'unknown' | 'unique_city' | 'multi_code_city' | 'ambiguous' | 'service_unavailable';
  message?: string;
}

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
  postalCode?: string | null;
  postalCodeSource?: string | null;
  postalResolution?: PostalResolutionMetadata;
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

export interface BarangayPostalSelectionInput {
  initialAddress: SelectedPsgcAddressLike | null | undefined;
  isSameLocality: boolean;
  freshResolution: PostalResolution;
}

export interface BarangayPostalSelectionResult {
  manualPostalCode: string;
  postalResolution: PostalResolutionMetadata | null;
}

/**
 * Determines the resulting postal code input value and resolution metadata
 * when a barangay is selected in the cascading selector.
 *
 * Precedence rule:
 * If the selected barangay matches the initial address's locality (same locality),
 * the initial address postal state takes precedence over the fresh lookup.
 * If the locality has changed, the fresh resolution takes precedence.
 */
export function resolveBarangaySelectionPostalState({
  initialAddress,
  isSameLocality: sameLocality,
  freshResolution,
}: BarangayPostalSelectionInput): BarangayPostalSelectionResult {
  if (sameLocality && initialAddress) {
    // 1. Same locality: strictly preserve existing visitor/form state
    if (initialAddress.postalCodeSource === 'PHLPost' && initialAddress.postalCode) {
      return {
        manualPostalCode: initialAddress.postalCode,
        postalResolution: initialAddress.postalResolution || {
          postalCode: initialAddress.postalCode,
          isAutoFilled: true,
          requiresConfirmation: false,
          mappingType: (freshResolution.mappingType as PostalResolutionMetadata['mappingType']) || 'unknown',
          message: freshResolution.message || 'PHLPost standard postal code',
        },
      };
    }

    if (initialAddress.postalCodeSource === 'manual' && initialAddress.postalCode) {
      return {
        manualPostalCode: initialAddress.postalCode,
        postalResolution: initialAddress.postalResolution || {
          postalCode: initialAddress.postalCode,
          isAutoFilled: false,
          requiresConfirmation: false,
          mappingType: 'unmapped',
        },
      };
    }

    // Postal code was cleared or absent in initial address
    return {
      manualPostalCode: initialAddress.postalCode || '',
      postalResolution: null,
    };
  }

  // 2. Different locality or no initial address: apply fresh lookup
  if (freshResolution.isAutoFilled && freshResolution.postalCode) {
    return {
      manualPostalCode: freshResolution.postalCode,
      postalResolution: freshResolution,
    };
  }

  return {
    manualPostalCode: '',
    postalResolution: freshResolution,
  };
}

export interface AddressConfirmationInput {
  initialAddress: SelectedPsgcAddressLike | null | undefined;
  selectedRegion: PsgcLocation;
  selectedProvince: PsgcLocation | null;
  selectedCity: PsgcLocation;
  selectedBarangay: PsgcLocation;
  postalResolution: PostalResolutionMetadata | null | undefined;
  manualPostalCode: string;
}

export interface AddressConfirmationResult {
  finalPostalCode: string | null;
  finalSource: 'PHLPost' | 'manual' | null;
  finalResolution: PostalResolutionMetadata | undefined;
  isSameLocality: boolean;
}

/**
 * Calculates final confirmed postal values upon clicking 'Confirm Address'.
 */
export function resolveAddressConfirmation({
  initialAddress,
  selectedRegion,
  selectedProvince,
  selectedCity,
  selectedBarangay,
  postalResolution,
  manualPostalCode,
}: AddressConfirmationInput): AddressConfirmationResult {
  const sameLocality = isSameLocality(initialAddress, {
    region: selectedRegion,
    province: selectedProvince,
    city: selectedCity,
    barangay: selectedBarangay,
  });

  if (sameLocality) {
    const candidateCode = manualPostalCode.trim() || null;
    if (!candidateCode) {
      return {
        finalPostalCode: null,
        finalSource: null,
        finalResolution: undefined,
        isSameLocality: true,
      };
    }

    if (
      initialAddress?.postalCodeSource === 'PHLPost' &&
      initialAddress.postalCode === candidateCode
    ) {
      return {
        finalPostalCode: candidateCode,
        finalSource: 'PHLPost',
        finalResolution: initialAddress.postalResolution || {
          postalCode: candidateCode,
          isAutoFilled: true,
          requiresConfirmation: false,
          mappingType: 'unknown',
          message: 'PHLPost standard postal code',
        },
        isSameLocality: true,
      };
    }

    return {
      finalPostalCode: candidateCode,
      finalSource: 'manual',
      finalResolution: {
        postalCode: candidateCode,
        isAutoFilled: false,
        requiresConfirmation: false,
        mappingType: 'unmapped',
      },
      isSameLocality: true,
    };
  }

  // Different locality:
  if (postalResolution?.isAutoFilled && postalResolution.postalCode) {
    return {
      finalPostalCode: postalResolution.postalCode,
      finalSource: 'PHLPost',
      finalResolution: postalResolution,
      isSameLocality: false,
    };
  }

  const candidateCode = manualPostalCode.trim() || null;
  if (candidateCode) {
    return {
      finalPostalCode: candidateCode,
      finalSource: 'manual',
      finalResolution: {
        postalCode: candidateCode,
        isAutoFilled: false,
        requiresConfirmation: false,
        mappingType: 'unmapped',
      },
      isSameLocality: false,
    };
  }

  return {
    finalPostalCode: null,
    finalSource: null,
    finalResolution: undefined,
    isSameLocality: false,
  };
}
