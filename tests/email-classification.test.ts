import { describe, expect, it } from 'vitest';
import { classifyResendHttpStatus, EmailDeliveryError } from '../server/email.js';

describe('EMAIL-H01: Resend HTTP Error Classification', () => {
  it.each([400, 401, 403, 422])('classifies client/validation error %i as definitive_rejection', (status) => {
    const result = classifyResendHttpStatus(status, { message: 'Validation failed' });
    expect(result.outcome).toBe('definitive_rejection');
    expect(result.code).toBe('resend_rejected');
    expect(result.message).toBe('Validation failed');
  });

  it('classifies 429 rate limit as unknown to prevent unsafe automatic retry', () => {
    const result = classifyResendHttpStatus(429, null);
    expect(result.outcome).toBe('unknown');
    expect(result.code).toBe('resend_rate_limited');
  });

  it.each([500, 502, 503, 504])('classifies server error %i as unknown', (status) => {
    const result = classifyResendHttpStatus(status, { message: 'Server error' });
    expect(result.outcome).toBe('unknown');
    expect(result.code).toBe('resend_server_error');
  });

  it('classifies unexpected non-2xx status as unknown', () => {
    const result = classifyResendHttpStatus(418, null);
    expect(result.outcome).toBe('unknown');
    expect(result.code).toBe('resend_status_uncertain');
  });
});
