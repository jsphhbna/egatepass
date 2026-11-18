import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import { handlePreloadError } from './lib/preloadRecovery';
import './index.css';

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root not found in the DOM');
}

const root = createRoot(rootElement);

function renderBootstrapFailure() {
  root.render(
    <main className="flex min-h-dvh items-center justify-center bg-[var(--color-canvas)] p-4">
      <section className="w-full max-w-xl rounded-2xl border border-[var(--color-danger)] bg-white p-6 shadow-sm sm:p-8" role="alert">
        <p className="text-xs font-bold uppercase tracking-widest text-[var(--color-danger)]">Application unavailable</p>
        <h1 className="mt-2 text-2xl font-bold text-[var(--color-text-primary)]">E-GatePass could not start</h1>
        <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
          Refresh the page and try again. If the problem continues, contact the system administrator.
        </p>
        <button type="button" onClick={() => window.location.reload()} className="mt-5 min-h-11 rounded-md bg-[var(--color-brand)] px-4 text-sm font-semibold text-white">
          Refresh Page
        </button>
      </section>
    </main>,
  );
}

root.render(
  <main className="flex min-h-dvh flex-col items-center justify-center bg-[var(--color-canvas)] px-4 select-none" role="status" aria-live="polite">
    <div className="flex flex-col items-center text-center max-w-sm w-full">
      <div className="relative mb-2 flex items-center justify-center">
        <div className="absolute -inset-2 rounded-full bg-[var(--color-brand)]/10 animate-pulse" aria-hidden="true" />
        <img src="/earist-logo.png" alt="EARIST seal" className="relative h-20 w-20 object-contain drop-shadow-sm" />
      </div>
      <span className="mt-3 text-2xl font-black tracking-tight text-[#700f14]">E-GatePass</span>
      <p className="mt-1 text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        Visitor Management System
      </p>
      <div className="mt-6 w-48 space-y-2">
        <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]/60">
          <div className="absolute inset-y-0 w-1/2 rounded-full bg-[var(--color-brand)] animate-progress-indeterminate" />
        </div>
        <div className="flex items-center justify-center gap-2 text-xs font-semibold text-[var(--color-text-secondary)]">
          <div className="h-3 w-3 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-brand)]" aria-hidden="true" />
          <span>Loading E-GatePass…</span>
        </div>
      </div>
    </div>
  </main>,
);

if (typeof window !== 'undefined') {
  window.addEventListener('vite:preloadError', (event: Event) => {
    handlePreloadError(event);
  });
}

void import('./App')
  .then(({ App }) => {
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );

    if (typeof window !== 'undefined' && 'serviceWorker' in navigator && import.meta.env.PROD) {
      window.addEventListener('load', () => {
        const swUrl = typeof __EGATEPASS_BUILD_ID__ !== 'undefined'
          ? `/sw.js?v=${encodeURIComponent(__EGATEPASS_BUILD_ID__)}`
          : '/sw.js';
        navigator.serviceWorker
          .register(swUrl)
          .then((reg) => {
            const assets = Array.from(document.querySelectorAll('script[src], link[rel="stylesheet"][href]'))
              .map((el) => el.getAttribute('src') || el.getAttribute('href'))
              .filter((url): url is string => Boolean(url && (url.startsWith('/assets/') || url.startsWith('/'))));
            const target = reg.active || reg.installing || navigator.serviceWorker.controller;
            target?.postMessage({ type: 'PRECACHE_ASSETS', assets });
          })
          .catch((err) => {
            console.warn('App shell service worker registration failed:', err);
          });
      });
    }
  })
  .catch((error: unknown) => {
    console.error('E-GatePass bootstrap failed.', error);
    renderBootstrapFailure();
  });
