/**
 * Cloudflare Turnstile Server-Side Siteverify Module
 *
 * Verifies Cloudflare Turnstile captcha tokens against Cloudflare Siteverify API.
 * Enforces expected hostname (production institutional domain egatepass.tech and permitted previews),
 * expected action matching, and strict fail-closed security semantics.
 */

export const ALLOWED_TURNSTILE_HOSTNAMES = new Set([
  'egatepass.tech',
  'www.egatepass.tech',
  'localhost',
  '127.0.0.1',
]);

const VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export interface TurnstileVerifyOptions {
  token: string;
  expectedAction?: string;
  expectedHostname?: string;
  remoteIp?: string;
  idempotencyKey?: string;
  secretKey?: string;
}

export interface TurnstileVerifyResult {
  success: boolean;
  hostname?: string;
  action?: string;
  cdata?: string;
  challengeTs?: string;
  errorCodes?: string[];
  error?: string;
}

interface CloudflareSiteverifyResponse {
  success: boolean;
  'error-codes'?: string[];
  challenge_ts?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
  messages?: string[];
}

/**
 * Checks if a hostname is permitted for Turnstile verification.
 * Permits production egatepass.tech, local loopback (localhost, 127.0.0.1),
 * and institutional Vercel preview domains (*.vercel.app).
 */
export function isValidTurnstileHostname(hostname?: string): boolean {
  if (!hostname || typeof hostname !== 'string') return false;
  const normalized = hostname.trim().toLowerCase();

  if (ALLOWED_TURNSTILE_HOSTNAMES.has(normalized)) {
    return true;
  }

  // Permitted Vercel preview deployments (e.g. egatepass-*.vercel.app or egatepass.vercel.app)
  if (normalized.endsWith('.vercel.app') && (normalized === 'egatepass.vercel.app' || normalized.startsWith('egatepass-'))) {
    return true;
  }

  return false;
}

/**
 * Validates a Turnstile token against Cloudflare Siteverify API.
 * Fails closed on missing configuration, missing token, API rejection,
 * hostname mismatch, or action mismatch.
 */
export async function verifyTurnstileToken(
  options: TurnstileVerifyOptions
): Promise<TurnstileVerifyResult> {
  const secretKey = options.secretKey || process.env.TURNSTILE_SECRET_KEY?.trim();

  if (!secretKey) {
    return {
      success: false,
      error: 'TURNSTILE_SECRET_KEY is not configured on server',
    };
  }

  const rawToken = options.token?.trim();
  if (!rawToken) {
    return {
      success: false,
      error: 'Turnstile verification token is missing or empty',
    };
  }

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secretKey);
    formData.append('response', rawToken);

    if (options.remoteIp?.trim()) {
      formData.append('remoteip', options.remoteIp.trim());
    }

    if (options.idempotencyKey?.trim()) {
      formData.append('idempotency_key', options.idempotencyKey.trim());
    }

    const response = await fetch(VERIFY_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: formData.toString(),
    });

    if (!response.ok) {
      return {
        success: false,
        error: `Cloudflare Siteverify HTTP error: ${response.status}`,
      };
    }

    const data = (await response.json()) as CloudflareSiteverifyResponse;

    if (!data.success) {
      return {
        success: false,
        errorCodes: data['error-codes'] || [],
        error: `Turnstile verification rejected: ${(data['error-codes'] || []).join(', ') || 'unspecified failure'}`,
      };
    }

    // Hostname Validation
    if (data.hostname) {
      if (!isValidTurnstileHostname(data.hostname)) {
        return {
          success: false,
          hostname: data.hostname,
          error: `Turnstile hostname rejected: ${data.hostname} is not an authorized hostname`,
        };
      }

      if (options.expectedHostname && data.hostname.toLowerCase() !== options.expectedHostname.trim().toLowerCase()) {
        return {
          success: false,
          hostname: data.hostname,
          error: `Turnstile hostname mismatch: expected ${options.expectedHostname}, got ${data.hostname}`,
        };
      }
    }

    // Action Validation
    if (options.expectedAction) {
      if (!data.action || data.action !== options.expectedAction) {
        return {
          success: false,
          action: data.action,
          error: `Turnstile action mismatch: expected ${options.expectedAction}, got ${data.action || 'none'}`,
        };
      }
    }

    return {
      success: true,
      hostname: data.hostname,
      action: data.action,
      cdata: data.cdata,
      challengeTs: data.challenge_ts,
    };
  } catch (err: unknown) {
    // Fail closed on network failure, timeout, or unexpected runtime error
    return {
      success: false,
      error: err instanceof Error ? `Turnstile siteverify exception: ${err.message}` : 'Turnstile siteverify failed unexpectedly',
    };
  }
}
