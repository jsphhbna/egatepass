/**
 * Bounded Fetch Utility with AbortController
 *
 * Guarantees that critical browser network calls cannot stall indefinitely and
 * trap UI state (loading spinners, debounce locks, camera captures, modal preventClose).
 */

export class RequestTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(message: string, timeoutMs: number) {
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
