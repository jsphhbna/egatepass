import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
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

root.render(<main className="min-h-dvh bg-[var(--color-canvas)]" aria-label="Loading E-GatePass" />);

void import('./App')
  .then(({ App }) => {
    root.render(
      <StrictMode>
        <ErrorBoundary>
          <App />
        </ErrorBoundary>
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    console.error('E-GatePass bootstrap failed.', error);
    renderBootstrapFailure();
  });
