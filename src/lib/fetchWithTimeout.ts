/**
 * Bounded Fetch Utility with AbortController
 *
 * Guarantees that critical browser network calls cannot stall indefinitely and
 * trap UI state (loading spinners, debounce locks, camera captures, modal preventClose).
 */

export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(message: string, timeoutMs: number = 15000) {
    super(message);
    this.name = 'TimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const callerSignal = init?.signal;

  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  // If caller already provided a signal, link it to abort controller
  if (callerSignal) {
    if (callerSignal.aborted) {
      clearTimeout(timeoutId);
      controller.abort();
    } else {
      callerSignal.addEventListener('abort', () => {
        clearTimeout(timeoutId);
        controller.abort();
      });
    }
  }

  try {
    const response = await fetch(input, {
      ...init,
      signal: controller.signal,
    });
    return response;
  } catch (err: any) {
    if (timedOut || err?.name === 'AbortError' && timedOut) {
      throw new RequestTimeoutError(
        `Request timed out after ${timeoutMs}ms. Please verify connection and retry.`,
        timeoutMs
      );
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Creates an AbortSignal that automatically aborts after the specified timeoutMs.
 * Compatible with Supabase PostgREST / RPC .abortSignal() modifier.
 */
export function createBoundedAbortSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new RequestTimeoutError(`Operation timed out after ${timeoutMs}ms`, timeoutMs));
  }, timeoutMs);
  if (typeof timeoutId === 'object' && timeoutId !== null && typeof (timeoutId as any).unref === 'function') {
    (timeoutId as any).unref();
  }
  return controller.signal;
}

/**
 * Generic deadline wrapper for promises (e.g. Supabase Storage uploads that do not support AbortSignal).
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  errorMessage = `Operation timed out after ${timeoutMs}ms`
): Promise<T> {
  let timer: any;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new RequestTimeoutError(errorMessage, timeoutMs));
    }, timeoutMs);
    if (typeof timer === 'object' && timer !== null && typeof timer.unref === 'function') {
      timer.unref();
    }
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}
