import { z } from 'zod';

/**
 * Standard PostgreSQL-compliant UUID regular expression.
 * PostgreSQL accepts any 32-hex-digit UUID formatted as 8-4-4-4-12,
 * regardless of RFC 4122 version or variant nibbles (e.g. deterministic seeded IDs
 * such as 11111111-0000-0000-0000-000000000001 through 000000000009).
 */
export const PG_UUID_REGEX = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const pgUuidSchema = z.string().regex(PG_UUID_REGEX, 'Invalid UUID');

export function isPgUuid(value: unknown): value is string {
  return typeof value === 'string' && PG_UUID_REGEX.test(value);
}
