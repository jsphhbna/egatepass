import { useEffect, useRef, useState } from 'react';
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
        }
      ) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

interface TurnstileWidgetProps {
  onVerify: (token: string) => void;
  onExpire?: () => void;
  onError?: (error: string) => void;
  resetKey?: number | string;
}

type TurnstileStatus = 'loading' | 'ready' | 'verified' | 'error';

export function TurnstileWidget({ onVerify, onExpire, onError, resetKey }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const siteKey = (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY?.trim();
  const isProd = Boolean((import.meta as any).env?.PROD);

  const [status, setStatus] = useState<TurnstileStatus>('loading');
  const [retryCount, setRetryCount] = useState(0);

  const onVerifyRef = useRef(onVerify);
  const onExpireRef = useRef(onExpire);
  const onErrorRef = useRef(onError);

  useEffect(() => {
    onVerifyRef.current = onVerify;
    onExpireRef.current = onExpire;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;

    let mounted = true;
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
          callback: (token: string) => {
            if (mounted) {
              setStatus('verified');
              if (onVerifyRef.current) onVerifyRef.current(token);
            }
          },
          'expired-callback': () => {
            if (mounted) {
              setStatus('ready');
              if (onExpireRef.current) onExpireRef.current();
            }
          },
          'error-callback': (err: string) => {
            if (mounted) {
              setStatus('error');
              if (onErrorRef.current) onErrorRef.current(err);
            }
          },
          theme: 'light',
          size: 'flexible',
        });
        if (mounted) {
          setStatus('ready');
        }
      } catch (e) {
        if (mounted) {
          setStatus('error');
          if (onErrorRef.current) onErrorRef.current(String(e));
        }
      }
    }

    if (window.turnstile) {
      renderWidget();
    } else {
      const existingScript = document.querySelector('script[src*="turnstile/v0/api.js"]');
      if (!existingScript) {
        const script = document.createElement('script');
        script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
        script.async = true;
        script.defer = true;
        script.onload = () => {
          if (mounted) renderWidget();
        };
        script.onerror = () => {
          if (mounted) {
            setStatus('error');
            if (onErrorRef.current) onErrorRef.current('script_load_failed');
          }
        };
        document.head.appendChild(script);
      } else {
        const interval = setInterval(() => {
          if (window.turnstile) {
            clearInterval(interval);
            if (mounted) renderWidget();
          }
        }, 100);
        return () => clearInterval(interval);
      }
    }

    return () => {
      mounted = false;
      if (widgetIdRef.current && window.turnstile) {
        try {
          window.turnstile.remove(widgetIdRef.current);
        } catch {
          // Ignore cleanup errors
        }
        widgetIdRef.current = null;
      }
    };
  }, [siteKey, resetKey, retryCount]);

  if (!siteKey) {
    if (isProd) {
      return (
        <div className="my-3 flex w-full justify-center" aria-live="polite">
          <div className="flex min-h-[65px] w-full max-w-sm items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] px-4 py-3 text-xs font-medium text-[var(--color-text-secondary)]">
            Security verification unavailable.
          </div>
        </div>
      );
    }
    return null;
  }

  return (
    <div className="my-3 flex w-full max-w-full flex-col items-center justify-center overflow-hidden">
      {status === 'loading' && (
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
        className={`w-full max-w-full overflow-hidden flex justify-center ${status === 'ready' || status === 'verified' ? 'block' : 'hidden'}`}
      />
    </div>
  );
}
