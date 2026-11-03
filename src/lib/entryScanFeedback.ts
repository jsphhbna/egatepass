/**
 * src/lib/entryScanFeedback.ts
 *
 * Production decision helper for Entry Scanner response evaluation and UI state mapping.
 * Shared directly between src/pages/EntryScanPage.tsx and its unit/integration test suites.
 *
 * Guarantees:
 * - Only explicit 'inside' transitions to 'granted' (green success indicator).
 * - Only explicit 'pending' transitions to 'pending' (amber waiting indicator for kiosk passes).
 * - Missing, empty, or unknown statuses fail closed to 'error' with explicit security guidance.
 * - HTTP failures, timeouts, and network interruptions map to deterministic error/warning states.
 */

export type ScanStatus = 'ready' | 'processing' | 'granted' | 'pending' | 'warning' | 'error';

export interface ScanPassSuccessPayload {
  status?: string | null;
  code?: string | null;
  message?: string | null;
  [key: string]: unknown;
}

export interface ScanPassErrorPayload {
  code?: string | null;
  error?: string | null;
  message?: string | null;
  [key: string]: unknown;
}

export type ScanNetworkFailureMode = 'timeout' | 'network' | null | undefined;

export interface EntryScanFeedbackOutcome {
  status: ScanStatus;
  statusMessage: string;
  toast: {
    type: 'success' | 'error';
    message: string;
  };
}

export const UNRECOGNIZED_STATUS_GUIDANCE =
  'Scanner received an unrecognized response. Do not allow entry based on this scan. Verify with the Guard or system administrator.';

export const TIMEOUT_STATUS_MESSAGE =
  'Scan verification timed out. Result could not be confirmed. Please try scanning again.';

export const NETWORK_UNAVAILABLE_STATUS_MESSAGE =
  'Entry verification is temporarily unavailable. Please proceed directly to the Guard for manual verification.';

/**
 * Resolves feedback for successful (HTTP 200) scan-pass API responses.
 * Fails closed if the status is unrecognized or missing.
 */
export function resolveEntryScanSuccess(
  payload: ScanPassSuccessPayload | null | undefined
): EntryScanFeedbackOutcome {
  const normalizedStatus = payload?.status?.trim();

  if (normalizedStatus === 'inside') {
    const message = payload?.message || 'Entry recorded. Please proceed through the normal security inspection.';
    return {
      status: 'granted',
      statusMessage: message,
      toast: {
        type: 'success',
        message: payload?.message || 'Pass scanned — entry granted',
      },
    };
  }

  if (normalizedStatus === 'pending') {
    const message = payload?.message || 'Scanned! Waiting for guard approval…';
    return {
      status: 'pending',
      statusMessage: message,
      toast: {
        type: 'success',
        message: 'Pass scanned — pending guard approval',
      },
    };
  }

  // Fail closed on any missing, null, empty, or unrecognized status
  return {
    status: 'error',
    statusMessage: UNRECOGNIZED_STATUS_GUIDANCE,
    toast: {
      type: 'error',
      message: 'Scanner received an unrecognized response. Do not allow entry.',
    },
  };
}

/**
 * Resolves feedback for failed HTTP responses or network exceptions.
 */
export function resolveEntryScanFailure(
  error: unknown,
  failureMode?: ScanNetworkFailureMode
): EntryScanFeedbackOutcome {
  if (failureMode === 'timeout') {
    return {
      status: 'error',
      statusMessage: TIMEOUT_STATUS_MESSAGE,
      toast: {
        type: 'error',
        message: 'Scan request timed out. Result could not be confirmed.',
      },
    };
  }

  const isNetworkObj =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'network_unavailable';

  if (failureMode === 'network' || isNetworkObj) {
    return {
      status: 'error',
      statusMessage: NETWORK_UNAVAILABLE_STATUS_MESSAGE,
      toast: {
        type: 'error',
        message: 'Network unavailable. Proceed to Guard for manual entry.',
      },
    };
  }

  const scanError = (typeof error === 'object' && error !== null)
    ? (error as { code?: string; message?: string; error?: string })
    : {};
  const message = scanError.message || scanError.error || 'Scan failed';
  const warningCodes = ['already_scanned', 'already_used', 'early'];
  const isWarning = warningCodes.includes(scanError.code || '');

  return {
    status: isWarning ? 'warning' : 'error',
    statusMessage: message,
    toast: {
      type: 'error',
      message,
    },
  };
}

/**
 * Unified entrypoint resolving any scan event into an EntryScanFeedbackOutcome.
 */
export function resolveEntryScanFeedback({
  responseOk,
  data,
  error,
  failureMode,
}: {
  responseOk: boolean;
  data?: ScanPassSuccessPayload | null;
  error?: unknown;
  failureMode?: ScanNetworkFailureMode;
}): EntryScanFeedbackOutcome {
  if (failureMode || !responseOk) {
    return resolveEntryScanFailure(error || data, failureMode);
  }
  return resolveEntryScanSuccess(data);
}
