/**
 * tests/entry-scan-feedback.test.ts
 *
 * Unit and integration tests for Entry Scanner feedback logic, scan status mapping,
 * and operational distinction between Online Portal passes ('inside') and Kiosk passes ('pending').
 */

import { describe, it, expect } from 'vitest';

type ScanStatus = 'ready' | 'processing' | 'granted' | 'pending' | 'warning' | 'error';

interface ScanPassResponse {
  status?: string;
  code?: string;
  error?: string;
  message?: string;
}

/**
 * Pure simulation of the EntryScanPage QR processing resolution logic.
 */
function resolveEntryScanFeedback(
  responseOk: boolean,
  data: ScanPassResponse | null,
  netError?: 'timeout' | 'network' | null
): { status: ScanStatus; message: string; toastType: 'success' | 'error'; bgVar: string } {
  if (netError === 'timeout') {
    return {
      status: 'error',
      message: 'Scan verification timed out. Result could not be confirmed. Please try scanning again.',
      toastType: 'error',
      bgVar: 'var(--color-danger)',
    };
  }

  if (netError === 'network') {
    return {
      status: 'error',
      message: 'Entry verification is temporarily unavailable. Please proceed directly to the Guard for manual verification.',
      toastType: 'error',
      bgVar: 'var(--color-danger)',
    };
  }

  if (!responseOk || !data) {
    const code = data?.code || 'scan_failed';
    const message = data?.error || data?.message || 'Scan failed';
    const warningCodes = ['already_scanned', 'already_used', 'early'];
    const isWarning = warningCodes.includes(code);
    return {
      status: isWarning ? 'warning' : 'error',
      message,
      toastType: 'error',
      bgVar: isWarning ? 'var(--color-warning-dark)' : 'var(--color-danger)',
    };
  }

  if (data.status === 'inside') {
    return {
      status: 'granted',
      message: data.message || 'Entry recorded. Please proceed through the normal security inspection.',
      toastType: 'success',
      bgVar: 'var(--color-success)',
    };
  }

  return {
    status: 'pending',
    message: data.message || 'Scanned! Waiting for guard approval…',
    toastType: 'success',
    bgVar: 'var(--color-warning-dark)',
  };
}

describe('Entry Scanner Feedback & Online vs Kiosk Distinction', () => {
  it('1. Online portal pass with status inside resolves to granted and success color', () => {
    const feedback = resolveEntryScanFeedback(true, {
      status: 'inside',
      message: 'Entry recorded. Please proceed through the normal security inspection.',
    });

    expect(feedback.status).toBe('granted');
    expect(feedback.message).toBe('Entry recorded. Please proceed through the normal security inspection.');
    expect(feedback.toastType).toBe('success');
    expect(feedback.bgVar).toBe('var(--color-success)');
  });

  it('2. Kiosk pass with status pending resolves to pending and warning-dark color', () => {
    const feedback = resolveEntryScanFeedback(true, {
      status: 'pending',
      message: 'Scanned! Waiting for guard approval…',
    });

    expect(feedback.status).toBe('pending');
    expect(feedback.message).toBe('Scanned! Waiting for guard approval…');
    expect(feedback.toastType).toBe('success');
    expect(feedback.bgVar).toBe('var(--color-warning-dark)');
  });

  it('3. Warning codes (already_scanned, already_used, early) map to warning status', () => {
    const alreadyScanned = resolveEntryScanFeedback(false, {
      code: 'already_scanned',
      error: 'Pass has already been scanned for entry',
    });
    expect(alreadyScanned.status).toBe('warning');
    expect(alreadyScanned.bgVar).toBe('var(--color-warning-dark)');

    const alreadyUsed = resolveEntryScanFeedback(false, {
      code: 'already_used',
      error: 'This pass has already been used and completed',
    });
    expect(alreadyUsed.status).toBe('warning');

    const early = resolveEntryScanFeedback(false, {
      code: 'early',
      error: 'Pass is not yet valid',
    });
    expect(early.status).toBe('warning');
  });

  it('4. Expired, invalid, or unrecognized codes map to error status', () => {
    const notFound = resolveEntryScanFeedback(false, {
      code: 'not_found',
      error: 'QR code not recognized',
    });
    expect(notFound.status).toBe('error');
    expect(notFound.bgVar).toBe('var(--color-danger)');

    const expired = resolveEntryScanFeedback(false, {
      code: 'expired',
      error: 'This pass has expired',
    });
    expect(expired.status).toBe('error');
    expect(expired.bgVar).toBe('var(--color-danger)');
  });

  it('5. Timeout and network errors map to error status with distinct operator guidance', () => {
    const timeout = resolveEntryScanFeedback(false, null, 'timeout');
    expect(timeout.status).toBe('error');
    expect(timeout.message).toContain('timed out');

    const network = resolveEntryScanFeedback(false, null, 'network');
    expect(network.status).toBe('error');
    expect(network.message).toContain('proceed directly to the Guard');
  });
});
