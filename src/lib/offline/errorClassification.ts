/**
 * Error Taxonomy & Classification for E-GatePass
 *
 * Separates failures into:
 * 1. Transport/backend unavailable (offline, network down, gateway failure where no authoritative decision was made)
 *    -> Eligible for safe offline fallback queueing
 * 2. Authoritative server responses (400, 401, 403, 409, 422, domain/SQL errors)
 *    -> MUST NEVER trigger offline fallback. Truthful server refusal must be displayed.
 */

export function isTransportOrNetworkError(err: unknown): boolean {
  if (!err) return false;

  // Browser offline signal
  if (typeof navigator !== 'undefined' && !navigator.onLine) {
    return true;
  }

  const e = err as any;

  // TypeError from fetch (e.g. Failed to fetch, NetworkError, Load failed)
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) {
    return true;
  }

  if (e.name === 'AbortError' || e.name === 'TimeoutError') {
    return true;
  }

  const msg = (e.message || String(err)).toLowerCase();
  if (
    msg.includes('failed to fetch') ||
    msg.includes('network request failed') ||
    msg.includes('networkerror') ||
    msg.includes('connection refused') ||
    msg.includes('connection reset') ||
    msg.includes('offline') ||
    msg.includes('load failed')
  ) {
    return true;
  }

  // 502 Bad Gateway, 503 Service Unavailable, 504 Gateway Timeout
  const status = Number(e.status || e.statusCode || 0);
  if (status === 502 || status === 503 || status === 504) {
    return true;
  }

  return false;
}

export function isAuthoritativeServerError(err: unknown): boolean {
  if (!err) return false;

  // If it's a genuine transport failure, it is not an authoritative response
  if (isTransportOrNetworkError(err)) {
    return false;
  }

  const e = err as any;

  // Explicit HTTP status codes from server
  const status = Number(e.status || e.statusCode || 0);
  if ([400, 401, 403, 404, 409, 422, 429].includes(status)) {
    return true;
  }

  // Database / SQL / PostgREST error codes
  if (e.code && typeof e.code === 'string') {
    return true;
  }

  // Common authoritative refusal patterns in message
  const msg = (e.message || '').toLowerCase();
  if (
    msg.includes('forbidden') ||
    msg.includes('unauthorized') ||
    msg.includes('conflict') ||
    msg.includes('not found') ||
    msg.includes('invalid') ||
    msg.includes('already') ||
    msg.includes('expired') ||
    msg.includes('permission') ||
    msg.includes('rejection') ||
    msg.includes('superadmin required') ||
    msg.includes('guard required') ||
    msg.includes('version conflict')
  ) {
    return true;
  }

  return false;
}
