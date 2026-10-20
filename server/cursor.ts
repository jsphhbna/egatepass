import { HttpError } from './actors.js';

export interface DecodedCursor {
  timestamp: string;
  id: string | null;
}

export interface CursorOptions {
  idType?: 'uuid' | 'bigint' | 'any';
  strict?: boolean;
}

const ISO_TIMESTAMP_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:?\d{2})?)?$/;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BIGINT_REGEX = /^\d{1,19}$/;

export function encodeCursor(timestamp: string, id: string | number): string {
  return Buffer.from(JSON.stringify({ t: timestamp, i: String(id) })).toString('base64url');
}

export function decodeCursor(
  cursor: string | null | undefined,
  options: CursorOptions = {}
): DecodedCursor | null {
  if (cursor === null || cursor === undefined) return null;
  const trimmed = cursor.trim();
  if (trimmed === '') return null;

  let timestamp: string | null = null;
  let id: string | null = null;

  try {
    const raw = Buffer.from(trimmed, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { t?: unknown; i?: unknown };
    if (parsed && typeof parsed.t === 'string') {
      timestamp = parsed.t;
      id = parsed.i !== undefined && parsed.i !== null ? String(parsed.i) : null;
    }
  } catch {
    // Non-JSON base64 or raw string fallback for legacy ISO timestamps
    if (ISO_TIMESTAMP_REGEX.test(trimmed)) {
      timestamp = trimmed;
      id = null;
    }
  }

  // Validate timestamp format and validity
  if (!timestamp || !ISO_TIMESTAMP_REGEX.test(timestamp) || Number.isNaN(Date.parse(timestamp))) {
    if (options.strict) throw new HttpError(400, 'invalid_cursor');
    return null;
  }

  // Validate ID format if present
  if (id !== null) {
    const idType = options.idType ?? 'any';
    let validId = false;

    if (idType === 'uuid') {
      validId = UUID_REGEX.test(id);
    } else if (idType === 'bigint') {
      validId = BIGINT_REGEX.test(id);
    } else {
      validId = UUID_REGEX.test(id) || BIGINT_REGEX.test(id);
    }

    if (!validId) {
      if (options.strict) throw new HttpError(400, 'invalid_cursor');
      return null;
    }
  }

  return { timestamp, id };
}

export function decodeCursorStrict(
  cursor: string | null | undefined,
  options: Omit<CursorOptions, 'strict'> = {}
): DecodedCursor | null {
  return decodeCursor(cursor, { ...options, strict: true });
}

export const encodeCompoundCursor = encodeCursor;
export const decodeCompoundCursor = decodeCursor;
