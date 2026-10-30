import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui';

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement | string,
        options: {
          sitekey: string;
          callback?: (token: string) => void;
          'error-callback'?: (errorCode: string) => void;
          'expired-callback'?: () => void;
          theme?: 'light' | 'dark' | 'auto';
          size?: 'normal' | 'flexible' | 'compact';
          execution?: 'render' | 'execute';
          appearance?: 'always' | 'execute' | 'interaction-only';
        }
      ) => string;
      reset: (widgetId: string) => void;
      execute: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

export interface TurnstileWidgetRef {
  executeChallenge: () => Promise<string>;
  resetChallenge: () => void;
}

interface TurnstileWidgetProps {
  onVerify?: (token: string) => void;
  onExpire?: () => void;
  onError?: (error: string) => void;
  resetKey?: number | string;
  execution?: 'render' | 'execute';
  appearance?: 'always' | 'execute' | 'interaction-only';
}

type TurnstileStatus = 'loading' | 'ready' | 'verified' | 'error';

export const TurnstileWidget = forwardRef<TurnstileWidgetRef, TurnstileWidgetProps>(function TurnstileWidget(
  {
    onVerify,
    onExpire,
    onError,
    resetKey,
    execution = 'render',
    appearance = 'always',
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const siteKey = (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY?.trim();

  const [status, setStatus] = useState<TurnstileStatus>('loading');
  const [retryCount, setRetryCount] = useState(0);

  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  const onErrorRef = useRef(onError);

  const pendingChallengeRef = useRef<{
    resolve: (token: string) => void;
    reject: (error: Error) => void;
  } | null>(null);

  useEffect(() => {
    onVerifyRef.current = onVerify;
    onExpireRef.current = onExpire;
    onErrorRef.current = onError;
  });

  useImperativeHandle(ref, () => ({
    executeChallenge: () => {
      if (!siteKey) {
        return Promise.reject(new Error('Security verification unavailable'));
      }

      return new Promise<string>((resolve, reject) => {
        if (pendingChallengeRef.current) {
          pendingChallengeRef.current.reject(new Error('challenge_superseded'));
        }

        const timeout = setTimeout(() => {
          if (pendingChallengeRef.current?.resolve === resolve) {
            pendingChallengeRef.current = null;
            reject(new Error('turnstile_challenge_timeout'));
          }
        }, 30000);

        pendingChallengeRef.current = {
          resolve: (tok: string) => {
            clearTimeout(timeout);
            resolve(tok);
          },
          reject: (err: Error) => {
            clearTimeout(timeout);
            reject(err);
          },
        };

        if (widgetIdRef.current && window.turnstile) {
          try {
            window.turnstile.reset(widgetIdRef.current);
            window.turnstile.execute(widgetIdRef.current);
          } catch (err) {
            clearTimeout(timeout);
            pendingChallengeRef.current = null;
            reject(new Error(`Failed to execute challenge: ${err}`));
          }
        }
      });
    },
    resetChallenge: () => {
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.reset(widgetIdRef.current);
        } catch {
          // ignore
        }
      }
      if (pendingChallengeRef.current) {
        pendingChallengeRef.current.reject(new Error('challenge_reset'));
        pendingChallengeRef.current = null;
      }
    },
  }));

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;

    let mounted = true;
    let intervalId: NodeJS.Timeout | null = null;
    let timeoutId: NodeJS.Timeout | null = null;

    setStatus('loading');

    function renderWidget() {
      if (!mounted || !containerRef.current || !window.turnstile) return;
      if (widgetIdRef.current) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // ignore
        }
        widgetIdRef.current = null;
      }

      try {
        widgetIdRef.current = window.turnstile.render(containerRef.current, {
          sitekey: siteKey,
          execution,
          appearance,
          callback: (token: string) => {
            if (mounted) {
              setStatus('verified');
              if (onVerifyRef.current) onVerifyRef.current(token);
              if (pendingChallengeRef.current) {
                const resolver = pendingChallengeRef.current.resolve;
                pendingChallengeRef.current = null;
                resolver(token);
              }
            }
          },
          'expired-callback': () => {
            if (mounted) {
              setStatus('ready');
              if (onExpireRef.current) onExpireRef.current();
              if (pendingChallengeRef.current) {
                const rejecter = pendingChallengeRef.current.reject;
                pendingChallengeRef.current = null;
                rejecter(new Error('challenge_expired'));
              }
            }
          },
          'error-callback': (err: string) => {
            if (mounted) {
              setStatus('error');
              if (onErrorRef.current) onErrorRef.current(err);
              if (pendingChallengeRef.current) {
                const rejecter = pendingChallengeRef.current.reject;
                pendingChallengeRef.current = null;
                rejecter(new Error(`challenge_error: ${err}`));
              }
            }
          },
          theme: 'light',
          size: 'flexible',
        });

        if (mounted) {
          setStatus('ready');
          // If a challenge was queued while widget was initializing, execute now
          if (execution === 'execute' && pendingChallengeRef.current && widgetIdRef.current) {
            try {
              window.turnstile.execute(widgetIdRef.current);
            } catch (err) {
              pendingChallengeRef.current.reject(new Error(`Failed to execute challenge: ${err}`));
              pendingChallengeRef.current = null;
            }
          }
        }
      } catch (e) {
        if (mounted) {
          setStatus('error');
          if (onErrorRef.current) onErrorRef.current(String(e));
          if (pendingChallengeRef.current) {
            pendingChallengeRef.current.reject(new Error(String(e)));
            pendingChallengeRef.current = null;
          }
        }
      }
    }

    if (window.turnstile) {
      renderWidget();
    } else {
      let existingScript = document.querySelector('script[src*="turnstile/v0/api.js"]');
      if (existingScript && retryCount > 0 && !window.turnstile) {
        existingScript.remove();
        existingScript = null;
      }

      if (!existingScript) {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.onload = () => {
          if (mounted && window.turnstile) {
            if (intervalId) clearInterval(intervalId);
            if (timeoutId) clearTimeout(timeoutId);
            renderWidget();
          }
        };
        script.onerror = () => {
          if (mounted) {
            if (intervalId) clearInterval(intervalId);
            if (timeoutId) clearTimeout(timeoutId);
            setStatus('error');
            if (onErrorRef.current) onErrorRef.current('script_load_failed');
            if (pendingChallengeRef.current) {
              pendingChallengeRef.current.reject(new Error('script_load_failed'));
              pendingChallengeRef.current = null;
            }
          }
        };
        document.head.appendChild(script);
      }

      intervalId = setInterval(() => {
        if (window.turnstile) {
          if (intervalId) clearInterval(intervalId);
          intervalId = null;
          if (timeoutId) clearTimeout(timeoutId);
          if (mounted) renderWidget();
        }
      }, 100);

      timeoutId = setTimeout(() => {
        if (intervalId) clearInterval(intervalId);
        intervalId = null;
        if (mounted && !window.turnstile) {
          setStatus('error');
          if (onErrorRef.current) onErrorRef.current('turnstile_initialization_timeout');
          if (pendingChallengeRef.current) {
            pendingChallengeRef.current.reject(new Error('turnstile_initialization_timeout'));
            pendingChallengeRef.current = null;
          }
        }
      }, 12_000);
    }

    return () => {
      mounted = false;
      if (intervalId) clearInterval(intervalId);
      if (timeoutId) clearTimeout(timeoutId);
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // Ignore cleanup errors
        }
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, resetKey, retryCount, execution, appearance]);

  if (!siteKey) {
    return (
      <div className="my-3 flex w-full justify-center" aria-live="polite">
        <div className="flex min-h-[65px] w-full max-w-sm items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-4 py-3 text-xs font-medium text-[var(--color-text-secondary)]">
          Security verification unavailable.
        </div>
      </div>
    );
  }

  return (
    <div className="my-3 flex w-full max-w-full flex-col items-center justify-center overflow-hidden">
      {status === 'loading' && appearance !== 'interaction-only' && (
        <div
          aria-live="polite"
          className="flex min-h-[65px] w-full max-w-sm items-center justify-center gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-4 py-3 text-xs text-[var(--color-text-secondary)]"
        >
          <Loader2 className="h-4 w-4 animate-spin text-[var(--color-brand)] shrink-0" aria-hidden="true" />
          <span>Loading security check…</span>
        </div>
      )}

      {status === 'error' && (
        <div
          role="alert"
          className="flex min-h-[65px] w-full max-w-sm flex-col items-center justify-center gap-2 rounded-lg border border-[var(--color-danger)]/30 bg-[var(--color-danger-light)]/50 px-4 py-3 text-center text-xs text-[var(--color-danger-dark)]"
        >
          <span>Security verification could not load.</span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setRetryCount((c) => c + 1)}
            icon={<RefreshCw className="h-3 w-3" />}
            className="text-xs h-7 px-3"
          >
            Retry
          </Button>
        </div>
      )}

      <div
        ref={containerRef}
        className={`w-full max-w-full overflow-hidden flex justify-center ${
          status === 'ready' || status === 'verified' ? 'block' : 'hidden'
        }`}
      />
    </div>
  );
});
