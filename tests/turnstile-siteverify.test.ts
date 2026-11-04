import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  verifyTurnstileToken,
  resetTurnstileReplayCache,
} from '../server/lib/turnstile.js';

describe('Cloudflare Turnstile Server-Side Siteverify Module', () => {
  const originalEnv = { ...process.env };
  const mockSecret = '0x4AAAAAAAFakeSecretKeyForTesting123';

  beforeEach(() => {
    process.env = { ...originalEnv };
    resetTurnstileReplayCache();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    resetTurnstileReplayCache();
    vi.restoreAllMocks();
  });

  it('rejects missing or empty token with missing_captcha_token', async () => {
    const resEmpty = await verifyTurnstileToken({ token: '', secretKey: mockSecret });
    expect(resEmpty.valid).toBe(false);
    expect(resEmpty.error).toBe('missing_captcha_token');

    const resWhitespace = await verifyTurnstileToken({ token: '   ', secretKey: mockSecret });
    expect(resWhitespace.valid).toBe(false);
    expect(resWhitespace.error).toBe('missing_captcha_token');
  });

  it('fails closed when runtime secret is missing or too short', async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const resNoSecret = await verifyTurnstileToken({ token: 'some-token' });
    expect(resNoSecret.valid).toBe(false);
    expect(resNoSecret.error).toBe('missing_validation_runtime_secret');

    const resShortSecret = await verifyTurnstileToken({ token: 'some-token', secretKey: 'short' });
    expect(resShortSecret.valid).toBe(false);
    expect(resShortSecret.error).toBe('missing_validation_runtime_secret');
  });

  it('detects and blocks replay of an already-consumed token', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          hostname: 'egatepass.tech',
          challenge_ts: new Date().toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const token = 'valid-token-for-replay-test';
    const firstRes = await verifyTurnstileToken({ token, secretKey: mockSecret });
    expect(firstRes.valid).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Second verification of identical token must fail in-memory without hitting Cloudflare
    const secondRes = await verifyTurnstileToken({ token, secretKey: mockSecret });
    expect(secondRes.valid).toBe(false);
    expect(secondRes.error).toBe('token_already_consumed');
    expect(fetchMock).toHaveBeenCalledTimes(1); // Not called again
  });

  it('rejects tokens when Cloudflare reports timeout-or-duplicate', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          'error-codes': ['timeout-or-duplicate'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await verifyTurnstileToken({ token: 'expired-token', secretKey: mockSecret });
    expect(res.valid).toBe(false);
    expect(res.error).toBe('expired_or_duplicate_token');
  });

  it('rejects tokens when Cloudflare reports invalid-input-response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          'error-codes': ['invalid-input-response'],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await verifyTurnstileToken({ token: 'invalid-token', secretKey: mockSecret });
    expect(res.valid).toBe(false);
    expect(res.error).toBe('invalid_captcha_token');
  });

  it('enforces hostname validation and rejects mismatched domains', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          hostname: 'malicious-phishing-site.com',
          challenge_ts: new Date().toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await verifyTurnstileToken({
      token: 'valid-token-wrong-domain',
      secretKey: mockSecret,
      expectedHostname: ['egatepass.tech', 'localhost'],
    });
    expect(res.valid).toBe(false);
    expect(res.error).toBe('wrong_hostname');
  });

  it('enforces action and cdata matching when specified', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            success: true,
            hostname: 'egatepass.tech',
            action: 'login',
            cdata: 'session-xyz',
            challenge_ts: new Date().toISOString(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );

    // Mismatched action
    const actionMismatch = await verifyTurnstileToken({
      token: 'token-action-test',
      secretKey: mockSecret,
      expectedAction: 'lookup_returning',
    });
    expect(actionMismatch.valid).toBe(false);
    expect(actionMismatch.error).toBe('wrong_action');

    // Mismatched cdata
    resetTurnstileReplayCache();
    const cdataMismatch = await verifyTurnstileToken({
      token: 'token-action-test',
      secretKey: mockSecret,
      expectedAction: 'login',
      expectedCdata: 'session-abc',
    });
    expect(cdataMismatch.valid).toBe(false);
    expect(cdataMismatch.error).toBe('wrong_cdata');
  });

  it('handles provider timeout gracefully by failing closed', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })
    );

    const res = await verifyTurnstileToken({
      token: 'timing-out-token',
      secretKey: mockSecret,
      timeoutMs: 100,
    });
    expect(res.valid).toBe(false);
    expect(res.error).toBe('siteverify_timeout');
  });

  it('handles provider HTTP 500 error by failing closed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('Internal Server Error', { status: 500 })
    );

    const res = await verifyTurnstileToken({
      token: 'provider-err-token',
      secretKey: mockSecret,
    });
    expect(res.valid).toBe(false);
    expect(res.error).toBe('siteverify_provider_error');
  });

  it('accepts valid response on authorized domain', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          hostname: 'egatepass.tech',
          action: 'lookup_returning',
          challenge_ts: new Date().toISOString(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const res = await verifyTurnstileToken({
      token: 'valid-approved-token',
      secretKey: mockSecret,
      expectedHostname: 'egatepass.tech',
      expectedAction: 'lookup_returning',
    });
    expect(res.valid).toBe(true);
    expect(res.hostname).toBe('egatepass.tech');
    expect(res.action).toBe('lookup_returning');
  });
});
