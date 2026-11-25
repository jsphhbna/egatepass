/**
 * Server-side Approximate Residential Location Contract & Utilities
 *
 * Re-exports the single authoritative coordinate contract from src/lib/homeLocation.ts.
 */
export {
  type HomeLocation,
  DEFAULT_CAMPUS_COORDINATES,
  type CoordinateValidationSuccess,
  type CoordinateValidationFailure,
  type CoordinateValidationResult,
  normalizeCoordinates,
} from '../../src/lib/homeLocation.js';
