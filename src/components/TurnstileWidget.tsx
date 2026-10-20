import { useEffect, useRef } from 'react';

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

export function TurnstileWidget({ onVerify, onExpire, onError, resetKey }: TurnstileWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | null>(null);
  const siteKey = (import.meta as any).env?.VITE_TURNSTILE_SITE_KEY?.trim();

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;

    let mounted = true;

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

      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (token: string) => {
          if (mounted) onVerify(token);
        },
        'expired-callback': () => {
          if (mounted && onExpire) onExpire();
        },
        'error-callback': (err: string) => {
          if (mounted && onError) onError(err);
        },
        theme: 'light',
      });
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
      }
    };
  }, [siteKey, resetKey, onVerify, onExpire, onError]);

  if (!siteKey) return null;

  return (
    <div className="my-3 flex justify-center">
      <div ref={containerRef} />
    </div>
  );
}
