/**
 * server/lib/turnstile.ts
 *
 * Cloudflare Turnstile Server-Side Siteverify & Abuse Defense Module
 *
 * ARCHITECTURAL NOTICE (November 2026):
 * Standalone server-side Turnstile verification via serverless functions is decommissioned.
 * Production Turnstile challenge validation is handled natively through Supabase Auth
 * (Authentication > Bot Protection / CAPTCHA) during anonymous and authenticated visitor
 * sign-ins. This eliminates the need to expose or configure TURNSTILE_SECRET_KEY in Vercel
 * serverless environments.
 *
 * The helpers below remain available for testing and historical contract compatibility.
 */

import { createHash } from 'node:crypto';

export interface TurnstileVerificationResult {
  valid: boolean;
  error?: string;
  message?: string;
  hostname?: string;
  action?: string;
  cdata?: string;
}

export interface VerifyTurnstileOptions {
  token: string;
  secretKey?: string;
  expectedHostname?: string | string[];
  expectedAction?: string;
  expectedCdata?: string;
  remoteIp?: string;
  timeoutMs?: number;
}

// In-memory replay cache with expiration (max 300 seconds TTL)
const replayCache = new Map<string, number>();

function purgeExpiredReplays(nowSec: number): void {
  for (const [hash, exp] of replayCache.entries()) {
    if (exp <= nowSec) {
      replayCache.delete(hash);
    }
  }
}

/**
 * Resets the replay cache (strictly for testing).
 */
export function resetTurnstileReplayCache(): void {
  replayCache.clear();
}

/**
 * Verifies a Cloudflare Turnstile response token against the siteverify API.
 */
export async function verifyTurnstileToken(
  options: VerifyTurnstileOptions
): Promise<TurnstileVerificationResult> {
  const {
    token,
    secretKey = process.env.TURNSTILE_SECRET_KEY?.trim(),
    expectedHostname = [
      'egatepass.tech',
      'www.egatepass.tech',
      'localhost',
      '127.0.0.1',
    ],
    expectedAction,
    expectedCdata,
    remoteIp,
    timeoutMs = 5000,
  } = options;

  if (!token || typeof token !== 'string' || token.trim().length === 0) {
    return {
      valid: false,
      error: 'missing_captcha_token',
      message: 'Verification challenge token required.',
    };
  }

  const trimmedToken = token.trim();

  // 1. Fail closed if secret key is missing or invalid
  if (!secretKey || secretKey.length < 10) {
    return {
      valid: false,
      error: 'missing_validation_runtime_secret',
      message: 'Turnstile verification runtime secret is unconfigured.',
    };
  }

  // 2. Anti-replay protection: verify token has not been consumed previously
  const tokenHash = createHash('sha256').update(trimmedToken).digest('hex');
  const nowSec = Math.floor(Date.now() / 1000);
  purgeExpiredReplays(nowSec);

  if (replayCache.has(tokenHash)) {
    return {
      valid: false,
      error: 'token_already_consumed',
      message: 'Verification challenge token has already been used.',
    };
  }

  // 3. Query Cloudflare Siteverify endpoint
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const postData = new URLSearchParams();
  postData.append('secret', secretKey);
  postData.append('response', trimmedToken);
  if (remoteIp) {
    postData.append('remoteip', remoteIp);
  }

  let response: Response;
  try {
    response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'E-GatePass-Verifier/1.0',
      },
      body: postData.toString(),
      signal: controller.signal,
    });
  } catch (err: any) {
    clearTimeout(timer);
    if (err?.name === 'AbortError' || controller.signal.aborted) {
      return {
        valid: false,
        error: 'siteverify_timeout',
        message: 'Verification provider timed out. Please try again.',
      };
    }
    return {
      valid: false,
      error: 'siteverify_provider_error',
      message: 'Verification provider communication error.',
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return {
      valid: false,
      error: 'siteverify_provider_error',
      message: `Verification provider returned HTTP ${response.status}.`,
    };
  }

  interface CloudflareSiteverifyResponse {
    success: boolean;
    'error-codes'?: string[];
    challenge_ts?: string;
    hostname?: string;
    action?: string;
    cdata?: string;
  }

  let data: CloudflareSiteverifyResponse;
  try {
    data = (await response.json()) as CloudflareSiteverifyResponse;
  } catch {
    return {
      valid: false,
      error: 'siteverify_provider_error',
      message: 'Failed to parse verification provider response.',
    };
  }

  // 4. Validate outcome
  if (!data.success) {
    const errorCodes = data['error-codes'] || [];
    if (errorCodes.includes('timeout-or-duplicate')) {
      return {
        valid: false,
        error: 'expired_or_duplicate_token',
        message: 'Verification challenge token has expired or was already verified.',
      };
    }
    return {
      valid: false,
      error: 'invalid_captcha_token',
      message: 'Verification challenge token rejected by provider.',
    };
  }

  // 5. Hostname validation
  if (data.hostname && expectedHostname) {
    const permitted = Array.isArray(expectedHostname) ? expectedHostname : [expectedHostname];
    const hostMatches = permitted.some((h) => {
      if (h.startsWith('*.')) {
        const domainSuffix = h.slice(2);
        return data.hostname === domainSuffix || data.hostname?.endsWith(`.${domainSuffix}`);
      }
      return data.hostname === h;
    });

    if (!hostMatches) {
      return {
        valid: false,
        error: 'wrong_hostname',
        message: 'Verification challenge was generated for an unauthorized hostname.',
        hostname: data.hostname,
      };
    }
  }

  // 6. Action validation
  if (expectedAction && data.action && data.action !== expectedAction) {
    return {
      valid: false,
      error: 'wrong_action',
      message: 'Verification challenge action mismatch.',
      action: data.action,
    };
  }

  // 7. Cdata validation
  if (expectedCdata && data.cdata && data.cdata !== expectedCdata) {
    return {
      valid: false,
      error: 'wrong_cdata',
      message: 'Verification challenge cdata mismatch.',
      cdata: data.cdata,
    };
  }

  // 8. Record in replay cache with 300s TTL
  replayCache.set(tokenHash, nowSec + 300);

  return {
    valid: true,
    hostname: data.hostname,
    action: data.action,
    cdata: data.cdata,
  };
}
