/**
 * Shared Philippine Mobile Number Validation & Normalization Contract.
 *
 * Rules:
 * - Local format: 09XXXXXXXXX (11 digits starting with 09)
 * - Country code format: 639XXXXXXXXX (11 digits starting with 639)
 * - International format: +639XXXXXXXXX (12 chars starting with +639)
 * - Tolerates whitespace, dashes, parentheses during entry
 * - Rejects 6309... (malformed prefix)
 * - Rejects 917... (missing leading 0 or 63)
 * - Rejects non-Philippine country codes
 * - Canonical storage: +639XXXXXXXXX (E.164 format, 13 chars)
 */

export interface PhPhoneValidationResult {
  valid: boolean;
  canonical?: string;
  formatted?: string;
  error?: string;
}

/**
 * Normalizes input phone string and returns canonical E.164 format (+639XXXXXXXXX)
 * or null if invalid.
 */
export function normalizePhMobile(input: string | null | undefined): string | null {
  if (!input || typeof input !== 'string') return null;

  // Strip spaces, dashes, parentheses, dots
  const cleaned = input.trim().replace(/[\s\-\(\)\.]+/g, '');
  if (!cleaned) return null;

  // Reject malformed 6309 prefix explicitly
  if (cleaned.startsWith('6309') || cleaned.startsWith('+6309')) {
    return null;
  }

  // Case 1: Starts with +63
  if (cleaned.startsWith('+63')) {
    const rest = cleaned.slice(3);
    if (/^9\d{9}$/.test(rest)) {
      return `+63${rest}`;
    }
    return null;
  }

  // Case 2: Starts with 63 without plus
  if (cleaned.startsWith('63')) {
    const rest = cleaned.slice(2);
    if (/^9\d{9}$/.test(rest)) {
      return `+63${rest}`;
    }
    return null;
  }

  // Case 3: Local format starting with 09
  if (cleaned.startsWith('09')) {
    const rest = cleaned.slice(1); // 9XXXXXXXXX
    if (/^9\d{9}$/.test(rest)) {
      return `+63${rest}`;
    }
    return null;
  }

  // All other formats (e.g. 917..., +1..., wrong length) are rejected
  return null;
}

/**
 * Validates a Philippine mobile number and provides human-readable feedback.
 */
export function validatePhMobile(input: string | null | undefined): PhPhoneValidationResult {
  if (!input || typeof input !== 'string' || !input.trim()) {
    return { valid: false, error: 'Mobile number is required.' };
  }

  const cleaned = input.trim().replace(/[\s\-\(\)\.]+/g, '');

  if (cleaned.startsWith('6309') || cleaned.startsWith('+6309')) {
    return {
      valid: false,
      error: 'Invalid format: please use 09XXXXXXXXX or +639XXXXXXXXX (do not combine 63 with 09).',
    };
  }

  if (cleaned.startsWith('+') && !cleaned.startsWith('+63')) {
    return {
      valid: false,
      error: 'Only Philippine mobile numbers (+639XXXXXXXXX) are supported.',
    };
  }

  if (cleaned.startsWith('9') && !cleaned.startsWith('09') && !cleaned.startsWith('639')) {
    return {
      valid: false,
      error: 'Please include the leading 0 (e.g., 09XXXXXXXXX).',
    };
  }

  const canonical = normalizePhMobile(input);
  if (!canonical) {
    return {
      valid: false,
      error: 'Please enter a valid 11-digit Philippine mobile number (09XXXXXXXXX or +639XXXXXXXXX).',
    };
  }

  // Formatted display: +63 917 123 4567
  const formatted = `${canonical.slice(0, 3)} ${canonical.slice(3, 6)} ${canonical.slice(6, 9)} ${canonical.slice(9)}`;

  return {
    valid: true,
    canonical,
    formatted,
  };
}
