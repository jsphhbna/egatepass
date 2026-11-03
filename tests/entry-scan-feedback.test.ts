/**
 * tests/entry-scan-feedback.test.ts
 *
 * Unit and integration tests for Entry Scanner feedback logic, scan status mapping,
 * and fail-closed security invariants.
 *
 * Directly tests the shared production implementation in src/lib/entryScanFeedback.ts.
 */

import { describe, it, expect } from 'vitest';
import {
  type ScanStatus,
  resolveEntryScanSuccess,
  resolveEntryScanFailure,
  resolveEntryScanFeedback,
  UNRECOGNIZED_STATUS_GUIDANCE,
  TIMEOUT_STATUS_MESSAGE,
  NETWORK_UNAVAILABLE_STATUS_MESSAGE,
} from '../src/lib/entryScanFeedback.js';

describe('Entry Scanner Production Feedback Logic (src/lib/entryScanFeedback.ts)', () => {
  // 1. Online Portal Pass
  it('1. Online portal pass with status inside resolves to granted, positive guidance, and success toast', () => {
    const feedback = resolveEntryScanSuccess({
      status: 'inside',
      message: 'Entry recorded. Please proceed through the normal security inspection.',
    });

    expect(feedback.status).toBe('granted');
    expect(feedback.statusMessage).toBe('Entry recorded. Please proceed through the normal security inspection.');
    expect(feedback.toast.type).toBe('success');
    expect(feedback.toast.message).toBe('Entry recorded. Please proceed through the normal security inspection.');
  });

  it('2. Online portal pass with status inside provides sensible default message when message is omitted', () => {
    const feedback = resolveEntryScanSuccess({
      status: 'inside',
    });

    expect(feedback.status).toBe('granted');
    expect(feedback.statusMessage).toBe('Entry recorded. Please proceed through the normal security inspection.');
    expect(feedback.toast.type).toBe('success');
    expect(feedback.toast.message).toBe('Pass scanned — entry granted');
  });

  // 2. Kiosk Pass
  it('3. Kiosk pass with status pending resolves to pending, waiting guidance, and success toast', () => {
    const feedback = resolveEntryScanSuccess({
      status: 'pending',
      message: 'Scanned! Waiting for guard approval…',
    });

    expect(feedback.status).toBe('pending');
    expect(feedback.statusMessage).toBe('Scanned! Waiting for guard approval…');
    expect(feedback.toast.type).toBe('success');
    expect(feedback.toast.message).toBe('Pass scanned — pending guard approval');
  });

  it('4. Kiosk pass with status pending preserves custom backend message', () => {
    const feedback = resolveEntryScanSuccess({
      status: 'pending',
      message: 'Kiosk pass scanned at Gate 1. Security review in progress.',
    });

    expect(feedback.status).toBe('pending');
    expect(feedback.statusMessage).toBe('Kiosk pass scanned at Gate 1. Security review in progress.');
  });

  // 3. Fail-Closed on Unrecognized Statuses (CRITICAL SECURITY INVARIANT)
  it('5. CRITICAL: Unrecognized status "approved" fails closed to error with security warning', () => {
    const feedback = resolveEntryScanSuccess({
      status: 'approved',
      message: 'Pass approved',
    });

    expect(feedback.status).toBe('error');
    expect(feedback.statusMessage).toBe(UNRECOGNIZED_STATUS_GUIDANCE);
    expect(feedback.toast.type).toBe('error');
    expect(feedback.toast.message).toContain('unrecognized response');
  });

  it('6. CRITICAL: Unexpected status "completed" or "exited" on entry scan fails closed to error', () => {
    const exitedResult = resolveEntryScanSuccess({ status: 'exited' });
    expect(exitedResult.status).toBe('error');
    expect(exitedResult.statusMessage).toBe(UNRECOGNIZED_STATUS_GUIDANCE);
    expect(exitedResult.toast.type).toBe('error');

    const completedResult = resolveEntryScanSuccess({ status: 'completed' });
    expect(completedResult.status).toBe('error');
    expect(completedResult.statusMessage).toBe(UNRECOGNIZED_STATUS_GUIDANCE);
    expect(completedResult.toast.type).toBe('error');
  });

  it('7. CRITICAL: Missing, null, or empty string status fails closed to error', () => {
    expect(resolveEntryScanSuccess(null).status).toBe('error');
    expect(resolveEntryScanSuccess(undefined).status).toBe('error');
    expect(resolveEntryScanSuccess({ status: null }).status).toBe('error');
    expect(resolveEntryScanSuccess({ status: '' }).status).toBe('error');
    expect(resolveEntryScanSuccess({ status: '   ' }).status).toBe('error');
    expect(resolveEntryScanSuccess({ message: 'Success without status' }).status).toBe('error');
  });

  // 4. Network and Timeout Failures
  it('8. Request timeout resolves to error status with retry guidance', () => {
    const feedback = resolveEntryScanFailure(null, 'timeout');
    expect(feedback.status).toBe('error');
    expect(feedback.statusMessage).toBe(TIMEOUT_STATUS_MESSAGE);
    expect(feedback.toast.type).toBe('error');
  });

  it('9. Network unavailable mode resolves to error with manual guard verification guidance', () => {
    const feedback = resolveEntryScanFailure(null, 'network');
    expect(feedback.status).toBe('error');
    expect(feedback.statusMessage).toBe(NETWORK_UNAVAILABLE_STATUS_MESSAGE);
    expect(feedback.toast.type).toBe('error');
  });

  it('10. Network error object with code network_unavailable resolves to error with manual guard guidance', () => {
    const feedback = resolveEntryScanFailure({ code: 'network_unavailable' });
    expect(feedback.status).toBe('error');
    expect(feedback.statusMessage).toBe(NETWORK_UNAVAILABLE_STATUS_MESSAGE);
  });

  // 5. Warning Codes vs Error Codes
  it('11. Warning codes (already_scanned, already_used, early) map to warning status', () => {
    const alreadyScanned = resolveEntryScanFailure({
      code: 'already_scanned',
      message: 'Pass has already been scanned for entry',
    });
    expect(alreadyScanned.status).toBe('warning');
    expect(alreadyScanned.statusMessage).toBe('Pass has already been scanned for entry');

    const alreadyUsed = resolveEntryScanFailure({
      code: 'already_used',
      message: 'This pass has already been used and exited',
    });
    expect(alreadyUsed.status).toBe('warning');

    const early = resolveEntryScanFailure({
      code: 'early',
      message: 'Pass is not yet valid',
    });
    expect(early.status).toBe('warning');
  });

  it('12. Standard failure codes (not_found, expired, invalid_request) map to error status', () => {
    const notFound = resolveEntryScanFailure({
      code: 'not_found',
      message: 'QR code not recognized',
    });
    expect(notFound.status).toBe('error');
    expect(notFound.statusMessage).toBe('QR code not recognized');

    const expired = resolveEntryScanFailure({
      code: 'expired',
      message: 'This pass has expired',
    });
    expect(expired.status).toBe('error');
    expect(expired.statusMessage).toBe('This pass has expired');
  });

  // 6. Unified Entrypoint resolveEntryScanFeedback
  it('13. Unified helper resolveEntryScanFeedback routes correctly across success and error permutations', () => {
    // Inside -> granted
    expect(resolveEntryScanFeedback({ responseOk: true, data: { status: 'inside' } }).status).toBe('granted');
    // Pending -> pending
    expect(resolveEntryScanFeedback({ responseOk: true, data: { status: 'pending' } }).status).toBe('pending');
    // Unknown status -> error
    expect(resolveEntryScanFeedback({ responseOk: true, data: { status: 'weird' } }).status).toBe('error');
    // Missing data -> error
    expect(resolveEntryScanFeedback({ responseOk: true, data: null }).status).toBe('error');
    // Timeout -> error
    expect(resolveEntryScanFeedback({ responseOk: false, failureMode: 'timeout' }).status).toBe('error');
    // Warning code -> warning
    expect(resolveEntryScanFeedback({ responseOk: false, error: { code: 'already_scanned', message: 'Already in' } }).status).toBe('warning');
  });
});
