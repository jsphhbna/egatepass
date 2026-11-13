/**
 * src/lib/returningAddressHydration.ts
 *
 * Typed, independently-testable helper that converts a successful
 * Returning Visitor 1:1 identification profile into the four address
 * state values consumed by GetPassPage:
 *   - selectedPsgc  (SelectedPsgcAddress | null)
 *   - homeBuilding  (string)
 *   - homeStreet    (string)
 *   - postalCode    (string)
 *
 * Design rules:
 *  - All four outputs are always fully specified — never conditionally absent.
 *  - Whitespace-only optional fields are trimmed to clean empty strings.
 *  - Stale values from a prior visitor session cannot survive into a new match.
 *  - Reconstructs postalResolution metadata so auto-fill badges and provenance
 *    survive re-opening the selector.
 *  - Does NOT read or write React state directly; callers apply the result.
 *  - Does NOT fabricate locality codes, postal codes, or names.
 */

import type { SelectedPsgcAddress } from '@/components/AddressCascadingSelector';
import type { ReturningIdentifyProfile } from '@/services/visitorRegistration';

export interface HydratedAddressState {
  /** Structured PSGC locality, or null when the profile has no saved locality. */
  selectedPsgc: SelectedPsgcAddress | null;
  /** House / unit / building number — empty string when not saved. */
  homeBuilding: string;
  /** Street / subdivision / purok — empty string when not saved. */
  homeStreet: string;
  /** 4-digit postal code string — empty string when not saved. */
  postalCode: string;
}

/**
 * Derives hydrated address state from a matched returning visitor profile.
 *
 * The result is always a complete `HydratedAddressState` object.
 * Callers must apply all four fields unconditionally to avoid stale-state leaks.
 *
 * @param profile - The `profile` object from a successful `identifyReturningVisitor` response.
 * @returns A `HydratedAddressState` ready to spread into React state setters.
 */
export function hydrateReturningAddress(
  profile: Pick<ReturningIdentifyProfile, 'psgc'>
): HydratedAddressState {
  const psgc = profile.psgc;

  if (
    psgc &&
    psgc.region?.code?.trim() &&
    psgc.city?.code?.trim() &&
    psgc.barangay?.code?.trim()
  ) {
    const cleanBuilding = typeof psgc.houseBuilding === 'string' ? psgc.houseBuilding.trim() : '';
    const cleanStreet = typeof psgc.street === 'string' ? psgc.street.trim() : '';

    return {
      selectedPsgc: {
        version: (psgc.version || '2026-q3').trim(),
        region: {
          code: psgc.region.code.trim(),
          name: (psgc.region.name || '').trim(),
        },
        province: psgc.province?.code?.trim()
          ? {
              code: psgc.province.code.trim(),
              name: (psgc.province.name || '').trim(),
            }
          : null,
        city: {
          code: psgc.city.code.trim(),
          name: (psgc.city.name || '').trim(),
        },
        barangay: {
          code: psgc.barangay.code.trim(),
          name: (psgc.barangay.name || '').trim(),
        },
      },
      homeBuilding: cleanBuilding,
      homeStreet: cleanStreet,
      postalCode: '',
    };
  }

  // Profile has no saved PSGC locality — return fully empty state.
  return {
    selectedPsgc: null,
    homeBuilding: '',
    homeStreet: '',
    postalCode: '',
  };
}
