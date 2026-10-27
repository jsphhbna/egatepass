export const PRELOAD_RECOVERY_KEY = 'egatepass_preload_recovery_at';
export const PRELOAD_RECOVERY_WINDOW_MS = 30000;

export interface PreloadRecoveryContext {
  isOnline?: boolean;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null;
  now?: () => number;
  reload?: () => void;
}

/**
 * Handles Vite chunk preload failures (vite:preloadError).
 * Prevents cyclic reloads by checking whether a recovery reload was already
 * initiated within PRELOAD_RECOVERY_WINDOW_MS. Suppresses reload when offline.
 */
export function handlePreloadError(
  event: { preventDefault: () => void },
  context: PreloadRecoveryContext = {}
): boolean {
  const isOnline = context.isOnline ?? (typeof navigator !== 'undefined' ? navigator.onLine : true);
  if (!isOnline) {
    return false;
  }

  const storage = context.storage !== undefined
    ? context.storage
    : (typeof window !== 'undefined' ? window.sessionStorage : null);

  const getNow = context.now ?? Date.now;
  const reload = context.reload ?? (() => {
    if (typeof window !== 'undefined') {
      window.location.reload();
    }
  });

  try {
    const lastRecovery = storage?.getItem(PRELOAD_RECOVERY_KEY);
    const now = getNow();
    if (!lastRecovery || now - parseInt(lastRecovery, 10) > PRELOAD_RECOVERY_WINDOW_MS) {
      event.preventDefault();
      storage?.setItem(PRELOAD_RECOVERY_KEY, String(now));
      reload();
      return true;
    }
    return false;
  } catch {
    // If storage is unavailable or throws, return false gracefully
    return false;
  }
}
