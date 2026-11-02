/**
 * Approximate Residential Location Contract & Utilities
 *
 * Provides three-decimal coordinate precision (~100m granularity)
 * for approximate residential area collection without reverse geocoding
 * or address autocomplete.
 */

export interface HomeLocation {
  lat: number;
  lon: number;
}

export const DEFAULT_OSM_TILE_URL =
  (typeof import.meta !== 'undefined' && import.meta.env?.VITE_OSM_TILE_URL) ||
  'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

export const DEFAULT_OSM_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors';

// EARIST Manila campus reference center (Nagtahan, Sampaloc, Manila)
export const DEFAULT_CAMPUS_COORDINATES: HomeLocation = {
  lat: 14.600,
  lon: 120.998,
};

export interface CoordinateValidationSuccess {
  valid: true;
  location: HomeLocation;
}

export interface CoordinateValidationFailure {
  valid: false;
  error: 'missing_coordinates' | 'invalid_coordinate_type' | 'coordinate_out_of_bounds';
  message: string;
}

export type CoordinateValidationResult =
  | CoordinateValidationSuccess
  | CoordinateValidationFailure;

/**
 * Normalizes and validates approximate residential coordinates.
 *
 * Rules:
 * - Rejects null/undefined when required.
 * - Rejects non-numbers, NaN, Infinity, -Infinity.
 * - Enforces latitude between -90 and 90.
 * - Enforces longitude between -180 and 180.
 * - Rounds to three decimal places (~100m granularity).
 * - Normalizes negative zero (-0) to positive zero (0).
 */
export function normalizeCoordinates(
  lat: unknown,
  lon: unknown,
  required = true
): CoordinateValidationResult {
  if (lat === null || lat === undefined || lon === null || lon === undefined) {
    if (!required) {
      return {
        valid: false,
        error: 'missing_coordinates',
        message: 'Coordinates are not provided.',
      };
    }
    return {
      valid: false,
      error: 'missing_coordinates',
      message: 'Approximate residential coordinates are required.',
    };
  }

  const numLat = typeof lat === 'number' ? lat : Number(lat);
  const numLon = typeof lon === 'number' ? lon : Number(lon);

  if (
    !Number.isFinite(numLat) ||
    !Number.isFinite(numLon) ||
    Number.isNaN(numLat) ||
    Number.isNaN(numLon)
  ) {
    return {
      valid: false,
      error: 'invalid_coordinate_type',
      message: 'Coordinates must be valid finite numbers.',
    };
  }

  if (numLat < -90 || numLat > 90 || numLon < -180 || numLon > 180) {
    return {
      valid: false,
      error: 'coordinate_out_of_bounds',
      message: 'Latitude must be between -90 and 90, and longitude between -180 and 180.',
    };
  }

  let roundedLat = Math.round(numLat * 1000) / 1000;
  let roundedLon = Math.round(numLon * 1000) / 1000;

  if (Object.is(roundedLat, -0)) roundedLat = 0;
  if (Object.is(roundedLon, -0)) roundedLon = 0;

  return {
    valid: true,
    location: {
      lat: roundedLat,
      lon: roundedLon,
    },
  };
}
