/**
 * Computed Backend Availability Contract for Guard Offline Operations
 *
 * Guarantees that Guard components do not claim "online" capability merely because
 * a browser network interface is up (navigator.onLine), if backend refresh or RPCs
 * are actively failing.
 */

export interface BackendAvailabilityInputs {
  isBrowserOnline: boolean;
  queueError?: boolean | null;
  refreshError?: boolean | null;
  lastRequestFailed?: boolean | null;
}

export function computeBackendAvailability(inputs: BackendAvailabilityInputs): boolean {
  if (!inputs.isBrowserOnline) {
    return false;
  }
  if (inputs.queueError) {
    return false;
  }
  if (inputs.refreshError) {
    return false;
  }
  if (inputs.lastRequestFailed) {
    return false;
  }
  return true;
}
