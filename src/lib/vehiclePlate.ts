/**
 * Shared Vehicle Declaration & Plate Normalization Contract.
 *
 * Requirements:
 * - Normalizes user input (spaces, hyphens) to clean uppercase display: "abc-1234" -> "ABC 1234"
 * - Maintains a canonical comparison key containing uppercase alphanumeric only: "ABC1234"
 * - Conservative validation: 3 to 10 alphanumeric characters
 * - Supports diverse Philippine plates: motorcycles, old formats, diplomatic/special, and modern series
 * - Supported vehicle types: Car, Motorcycle, Van, Pickup, Other
 */

export const VEHICLE_TYPES = ['Car', 'Motorcycle', 'Van', 'Pickup', 'Other'] as const;
export type VehicleType = (typeof VEHICLE_TYPES)[number];

export interface PlateNormalizationResult {
  valid: boolean;
  displayPlate: string;
  plateKey: string;
  error?: string;
}

/**
 * Normalizes a plate number into display format (e.g. "ABC 1234") and canonical comparison key ("ABC1234").
 */
export function normalizePlateNumber(input: string | null | undefined): PlateNormalizationResult {
  if (!input || typeof input !== 'string') {
    return { valid: false, displayPlate: '', plateKey: '', error: 'Plate number is required.' };
  }

  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, displayPlate: '', plateKey: '', error: 'Plate number is required.' };
  }

  // Comparison key: uppercase alphanumeric only
  const plateKey = trimmed.toUpperCase().replace(/[^A-Z0-9]/g, '');

  if (plateKey.length < 3) {
    return {
      valid: false,
      displayPlate: trimmed.toUpperCase(),
      plateKey,
      error: 'Plate number is too short (minimum 3 characters).',
    };
  }

  if (plateKey.length > 10) {
    return {
      valid: false,
      displayPlate: trimmed.toUpperCase(),
      plateKey,
      error: 'Plate number is too long (maximum 10 characters).',
    };
  }

  // Display normalization:
  // If user provided a hyphen or space separating letters and numbers, format nicely
  // Standard format detection: letters followed by numbers, or numbers followed by letters
  let displayPlate = trimmed.toUpperCase().replace(/[\s\-_]+/g, ' ');

  // If there are no separators and matches standard patterns (e.g. "ABC1234" -> "ABC 1234", "123ABC" -> "123 ABC")
  const standardLetterNumber = plateKey.match(/^([A-Z]{2,4})(\d{2,5})$/);
  const standardNumberLetter = plateKey.match(/^(\d{2,5})([A-Z]{2,4})$/);

  if (!displayPlate.includes(' ')) {
    if (standardLetterNumber) {
      displayPlate = `${standardLetterNumber[1]} ${standardLetterNumber[2]}`;
    } else if (standardNumberLetter) {
      displayPlate = `${standardNumberLetter[1]} ${standardNumberLetter[2]}`;
    } else {
      displayPlate = plateKey;
    }
  }

  return {
    valid: true,
    displayPlate,
    plateKey,
  };
}

export const normalizeVehiclePlate = normalizePlateNumber;
