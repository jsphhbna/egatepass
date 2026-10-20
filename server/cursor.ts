export interface DecodedCursor {
  timestamp: string;
  id: string | null;
}

export function encodeCursor(timestamp: string, id: string | number): string {
  return Buffer.from(JSON.stringify({ t: timestamp, i: String(id) })).toString('base64url');
}

export function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
  if (!cursor) return null;
  const trimmed = cursor.trim();
  if (!trimmed) return null;

  try {
    const raw = Buffer.from(trimmed, 'base64url').toString('utf8');
    const parsed = JSON.parse(raw) as { t?: string; i?: string };
    if (parsed && typeof parsed.t === 'string' && parsed.t.length >= 10) {
      return { timestamp: parsed.t, id: parsed.i ? String(parsed.i) : null };
    }
  } catch {
    // Non-JSON base64 or raw string
  }

  // Graceful fallback for legacy ISO timestamp cursors
  if (/^\d{4}-\d{2}-\d{2}/.test(trimmed)) {
    return { timestamp: trimmed, id: null };
  }

  return null;
}

export const encodeCompoundCursor = encodeCursor;
export const decodeCompoundCursor = decodeCursor;
