import { isIP } from 'node:net';

/**
 * Extracts the trusted client IP address strictly from Vercel's authoritative
 * forwarding header (`x-vercel-forwarded-for`).
 *
 * Security requirements:
 * 1. For direct-to-Vercel deployments, Vercel strips untrusted client-supplied headers
 *    and populates `x-vercel-forwarded-for` with the remote client IP.
 * 2. `CF-Connecting-IP` is NOT trusted because clients can spoof it directly when
 *    connecting to Vercel without a cryptographically verified Cloudflare proxy chain.
 * 3. `X-Real-IP` and arbitrary `X-Forwarded-For` headers are strictly rejected.
 * 4. Only syntactically valid IPv4 or IPv6 addresses are accepted.
 */
export function getTrustedClientIp(request: Request): string | null {
  const vercelForwardedFor = request.headers.get('x-vercel-forwarded-for');
  if (!vercelForwardedFor) {
    return null;
  }

  // Vercel may provide a comma-separated list of IPs; the first hop represents the client IP.
  const candidate = vercelForwardedFor.split(',')[0]?.trim();
  if (candidate && isIP(candidate)) {
    return candidate;
  }

  return null;
}

/**
 * Alias for getTrustedClientIp matching codebase naming conventions.
 */
export const extractTrustedClientIp = getTrustedClientIp;
export const getClientIp = getTrustedClientIp;
