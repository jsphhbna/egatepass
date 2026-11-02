/**
 * Server-side Approximate Residential Location Contract & Utilities
 *
 * Normalizes and validates coordinates to three decimal places (~100m).
 */

export interface HomeLocation {
  lat: number;
  lon: number;
}

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
