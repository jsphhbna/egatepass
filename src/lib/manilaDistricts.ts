/**
 * src/lib/manilaDistricts.ts
 *
 * Philippine Standard Geographic Code (PSGC) auxiliary structure for City of Manila (1380600000).
 * Provides dependent hierarchical selection:
 * Congressional District (I - VI) -> Administrative District / Area -> Barangay.
 *
 * Preserves canonical PSGC barangay output and full compatibility with existing PSGC records.
 */

import type { PsgcLocation } from './psgc';
import { MANILA_BARANGAY_DIRECTORY } from './manilaBarangayDirectory';

export const MANILA_CITY_PSGC_CODE = '1380600000';

export interface ManilaAreaDef {
  readonly administrativeDistrict: string;
  readonly congressionalDistrict: string;
  readonly minBarangay?: number;
  readonly maxBarangay?: number;
  readonly specificBarangays?: readonly number[];
  readonly aliases?: readonly string[];
}

export const MANILA_CONGRESSIONAL_DISTRICTS = [
  'District I',
  'District II',
  'District III',
  'District IV',
  'District V',
  'District VI',
] as const;

export type ManilaCongressionalDistrict = (typeof MANILA_CONGRESSIONAL_DISTRICTS)[number];

export const MANILA_AREAS: readonly ManilaAreaDef[] = [
  // District I
  {
    administrativeDistrict: 'Tondo I',
    congressionalDistrict: 'District I',
    minBarangay: 1,
    maxBarangay: 146,
    aliases: ['Tondo West', 'Tondo 1', 'Tondo (West)'],
  },
  // District II
  {
    administrativeDistrict: 'Tondo II',
    congressionalDistrict: 'District II',
    minBarangay: 147,
    maxBarangay: 267,
    aliases: ['Tondo East', 'Gagalangin', 'Tondo 2', 'Tondo (East)'],
  },
  // District III
  {
    administrativeDistrict: 'Binondo',
    congressionalDistrict: 'District III',
    minBarangay: 287,
    maxBarangay: 296,
  },
  {
    administrativeDistrict: 'Quiapo',
    congressionalDistrict: 'District III',
    minBarangay: 383,
    maxBarangay: 394,
  },
  {
    administrativeDistrict: 'San Nicolas',
    congressionalDistrict: 'District III',
    minBarangay: 268,
    maxBarangay: 286,
  },
  {
    administrativeDistrict: 'Santa Cruz',
    congressionalDistrict: 'District III',
    minBarangay: 297,
    maxBarangay: 382,
    aliases: ['Sta. Cruz', 'Sta Cruz'],
  },
  // District IV
  {
    administrativeDistrict: 'Sampaloc',
    congressionalDistrict: 'District IV',
    minBarangay: 395,
    maxBarangay: 586,
  },
  // District V
  {
    administrativeDistrict: 'Ermita',
    congressionalDistrict: 'District V',
    minBarangay: 659,
    maxBarangay: 670,
  },
  {
    administrativeDistrict: 'Intramuros',
    congressionalDistrict: 'District V',
    minBarangay: 654,
    maxBarangay: 658,
  },
  {
    administrativeDistrict: 'Malate',
    congressionalDistrict: 'District V',
    minBarangay: 688,
    maxBarangay: 744,
  },
  {
    administrativeDistrict: 'Paco',
    congressionalDistrict: 'District V',
    minBarangay: 671,
    maxBarangay: 685,
    specificBarangays: [671, 672, 673, 674, 675, 676, 677, 678, 679, 680, 681, 682, 683, 684, 685, 687],
    aliases: ['Paco (South)', 'Paco South'],
  },
  {
    administrativeDistrict: 'Port Area',
    congressionalDistrict: 'District V',
    minBarangay: 649,
    maxBarangay: 653,
  },
  {
    administrativeDistrict: 'San Andres',
    congressionalDistrict: 'District V',
    minBarangay: 745,
    maxBarangay: 820,
    aliases: ['San Andres Bukid'],
  },
  // District VI
  {
    administrativeDistrict: 'Paco',
    congressionalDistrict: 'District VI',
    minBarangay: 821,
    maxBarangay: 828,
    specificBarangays: [686, 821, 822, 823, 824, 825, 826, 827, 828],
    aliases: ['Paco (North)', 'Paco North'],
  },
  {
    administrativeDistrict: 'Pandacan',
    congressionalDistrict: 'District VI',
    minBarangay: 829,
    maxBarangay: 872,
  },
  {
    administrativeDistrict: 'San Miguel',
    congressionalDistrict: 'District VI',
    minBarangay: 637,
    maxBarangay: 648,
  },
  {
    administrativeDistrict: 'Santa Ana',
    congressionalDistrict: 'District VI',
    minBarangay: 873,
    maxBarangay: 905,
    aliases: ['Sta. Ana', 'Sta Ana'],
  },
  {
    administrativeDistrict: 'Santa Mesa',
    congressionalDistrict: 'District VI',
    minBarangay: 587,
    maxBarangay: 636,
    aliases: ['Sta. Mesa', 'Sta Mesa'],
  },
];

/**
 * Check if a city is the City of Manila.
 */
export function isCityOfManila(cityCode?: string | null, cityName?: string | null): boolean {
  if (cityCode === MANILA_CITY_PSGC_CODE) return true;
  if (!cityName) return false;
  const normalized = cityName.trim().toLowerCase();
  return normalized === 'city of manila' || normalized === 'manila' || normalized === 'manila, city of';
}

/**
 * Get the list of all 6 Congressional Districts in Manila.
 */
export function getManilaCongressionalDistricts(): readonly string[] {
  return MANILA_CONGRESSIONAL_DISTRICTS;
}

/**
 * Get the unique administrative districts / areas in Manila, optionally filtered by Congressional District.
 */
export function getManilaAdministrativeDistricts(congressionalDistrict?: string | null): string[] {
  const filtered = congressionalDistrict
    ? MANILA_AREAS.filter((a) => a.congressionalDistrict === congressionalDistrict)
    : MANILA_AREAS;
  const unique = Array.from(new Set(filtered.map((a) => a.administrativeDistrict)));
  return unique.sort((a, b) => a.localeCompare(b));
}

/**
 * Extract integer barangay number from a barangay name or code.
 * Handles "Barangay 408 (Sampaloc...)", "Barangay 287", or code "1380600408".
 */
export function extractBarangayNumber(nameOrCode: string): number | null {
  const match = nameOrCode.match(/\b(?:barangay\s*|brgy\.?\s*|bgy\.?\s*)(\d+)\b/i);
  if (match && match[1]) {
    const num = parseInt(match[1], 10);
    if (!isNaN(num) && num > 0) return num;
  }
  // Try matching purely numeric tail if 10-digit PSGC code (e.g. 1380600408 -> 408)
  if (/^\d{10}$/.test(nameOrCode) && nameOrCode.startsWith('138060')) {
    const tail = parseInt(nameOrCode.slice(6), 10);
    if (!isNaN(tail) && tail > 0) return tail;
  }
  return null;
}

/**
 * Lookup the Congressional District and Administrative District for a given Manila barangay.
 */
export function lookupManilaDistrictForBarangay(
  barangay: { code?: string; name: string } | string
): { congressionalDistrict: string; administrativeDistrict: string } | null {
  const name = typeof barangay === 'string' ? barangay : barangay.name || '';
  const code = typeof barangay === 'object' ? barangay.code : undefined;

  // 1. Authoritative lookup from compiled PSA directory by PSGC code
  if (code && MANILA_BARANGAY_DIRECTORY[code]) {
    const entry = MANILA_BARANGAY_DIRECTORY[code];
    return {
      congressionalDistrict: entry.congressionalDistrict,
      administrativeDistrict: entry.administrativeDistrict,
    };
  }

  const bgyNumber = extractBarangayNumber(name) || (code ? extractBarangayNumber(code) : null);

  // 2. Authoritative lookup from compiled PSA directory by barangay number
  if (bgyNumber !== null) {
    const match = Object.values(MANILA_BARANGAY_DIRECTORY).find((e) => e.bgyNumber === bgyNumber);
    if (match) {
      return {
        congressionalDistrict: match.congressionalDistrict,
        administrativeDistrict: match.administrativeDistrict,
      };
    }
  }

  // 3. Fallback: check explicit area name in parentheses/slashes, e.g. "Barangay 306 (Santa Cruz)"
  for (const area of MANILA_AREAS) {
    const targets = [area.administrativeDistrict, ...(area.aliases || [])];
    for (const target of targets) {
      const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`[\\(/]\\s*${escaped}[\\s\\)/]`, 'i');
      if (regex.test(name)) {
        // Special case: Paco is divided between District V and District VI.
        if (area.administrativeDistrict === 'Paco' && bgyNumber !== null) {
          const isDist6 = bgyNumber >= 821 || bgyNumber === 686;
          const matchedArea = MANILA_AREAS.find(
            (a) =>
              a.administrativeDistrict === 'Paco' &&
              (isDist6 ? a.congressionalDistrict === 'District VI' : a.congressionalDistrict === 'District V')
          );
          if (matchedArea) {
            return {
              congressionalDistrict: matchedArea.congressionalDistrict,
              administrativeDistrict: matchedArea.administrativeDistrict,
            };
          }
        }
        return {
          congressionalDistrict: area.congressionalDistrict,
          administrativeDistrict: area.administrativeDistrict,
        };
      }
    }
  }

  // 2. Extract numeric barangay number for exact district allocation when no explicit area name
  if (bgyNumber !== null) {
    for (const area of MANILA_AREAS) {
      if (area.specificBarangays && area.specificBarangays.includes(bgyNumber)) {
        return {
          congressionalDistrict: area.congressionalDistrict,
          administrativeDistrict: area.administrativeDistrict,
        };
      }
      if (
        area.minBarangay !== undefined &&
        area.maxBarangay !== undefined &&
        bgyNumber >= area.minBarangay &&
        bgyNumber <= area.maxBarangay
      ) {
        return {
          congressionalDistrict: area.congressionalDistrict,
          administrativeDistrict: area.administrativeDistrict,
        };
      }
    }
  }

  return null;
}

/**
 * Filter a list of Manila barangays by Congressional District and/or Administrative District.
 */
export function filterManilaBarangays(
  barangays: PsgcLocation[],
  filters: { congressionalDistrict?: string | null; administrativeDistrict?: string | null }
): PsgcLocation[] {
  const { congressionalDistrict, administrativeDistrict } = filters;
  if (!congressionalDistrict && !administrativeDistrict) {
    return barangays;
  }

  return barangays.filter((bgy) => {
    const match = lookupManilaDistrictForBarangay(bgy);
    if (!match) {
      // If we cannot determine, do not exclude to prevent user being blocked
      return true;
    }
    if (congressionalDistrict && match.congressionalDistrict !== congressionalDistrict) {
      return false;
    }
    if (administrativeDistrict && match.administrativeDistrict !== administrativeDistrict) {
      return false;
    }
    return true;
  });
}
