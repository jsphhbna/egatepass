import { Component, ErrorInfo, ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { RefreshCw, RotateCcw } from 'lucide-react';

export type DiagnosticCategory = 'chunk_load' | 'render_error' | 'unknown';

export function isChunkLoadError(error: unknown): boolean {
  if (!error) return false;
  const msg = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  return (
    name === 'ChunkLoadError' ||
    /Failed to fetch dynamically imported module/i.test(msg) ||
    /Importing a module script failed/i.test(msg) ||
    /error loading dynamically imported module/i.test(msg) ||
    /ChunkLoadError/i.test(msg) ||
    /preloadError/i.test(msg)
  );
}

export function classifyError(error: unknown): DiagnosticCategory {
  if (isChunkLoadError(error)) return 'chunk_load';
  if (error instanceof Error) return 'render_error';
  return 'unknown';
}

interface InnerProps {
  children?: ReactNode;
  resetKey?: string;
  className?: string;
  onReset?: () => void;
}

interface InnerState {
  hasError: boolean;
  error: unknown;
  category: DiagnosticCategory | null;
}

export class RouteErrorBoundaryInner extends Component<InnerProps, InnerState> {
  public state: InnerState = {
    hasError: false,
    error: null,
    category: null,
  };

  public static getDerivedStateFromError(error: unknown): InnerState {
    return {
      hasError: true,
      error,
      category: classifyError(error),
    };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[RouteErrorBoundary] Caught error:', error, errorInfo);
  }

  public componentDidUpdate(prevProps: InnerProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.reset();
    }
  }

  public reset = () => {
    this.setState({ hasError: false, error: null, category: null });
    this.props.onReset?.();
  };

  public render() {
    if (this.state.hasError) {
      const isChunk = this.state.category === 'chunk_load';
      const buildId = typeof __EGATEPASS_BUILD_ID__ !== 'undefined' ? __EGATEPASS_BUILD_ID__ : 'dev';
      const route = this.props.resetKey || (typeof window !== 'undefined' ? window.location.pathname : '');
      const diagnosticRef = `build:${buildId} · route:${route} · type:${this.state.category || 'unknown'}`;

      return (
        <section
          role="alert"
          aria-live="assertive"
          className={`flex min-h-[360px] flex-col items-center justify-center p-6 text-center ${this.props.className || ''}`}
        >
          <div className="w-full max-w-lg rounded-2xl border border-[var(--color-border)] bg-white p-6 shadow-sm sm:p-8">
            <p className="text-xs font-bold uppercase tracking-widest text-[var(--color-brand)]">
              {isChunk ? 'Update Available' : 'Section Unavailable'}
            </p>
            <h2 className="mt-2 text-xl font-bold text-[var(--color-text-primary)]">
              {isChunk
                ? 'A newer version of E-GatePass may be available.'
                : 'This section encountered an unexpected error.'}
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">
              {isChunk
                ? 'A newer version of the application was deployed. Please refresh the application to load the latest components.'
                : 'An unexpected issue occurred while rendering this section. You can try reloading it, or refresh the entire application.'}
            </p>

            <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
              {!isChunk && (
                <button
                  type="button"
                  onClick={this.reset}
                  className="inline-flex min-h-10 items-center gap-2 rounded-md border border-[var(--color-border)] bg-white px-4 text-sm font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-canvas)]"
                >
                  <RotateCcw className="h-4 w-4" />
                  Try Again
                </button>
              )}
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="inline-flex min-h-10 items-center gap-2 rounded-md bg-[var(--color-brand)] px-4 text-sm font-semibold text-white hover:bg-[var(--color-brand-dark)]"
              >
                <RefreshCw className="h-4 w-4" />
                Refresh Application
              </button>
            </div>

            <div className="mt-6 border-t border-[var(--color-border)] pt-3 text-[11px] font-mono text-[var(--color-text-muted)]">
              Diagnostic reference: {diagnosticRef}
            </div>
          </div>
        </section>
      );
    }

    return this.props.children;
  }
}

export function RouteErrorBoundary(props: {
  children?: ReactNode;
  className?: string;
  onReset?: () => void;
  resetKey?: string;
}) {
  const location = useLocation();
  const effectiveResetKey = props.resetKey ?? location.pathname;
  return <RouteErrorBoundaryInner key={effectiveResetKey} {...props} resetKey={effectiveResetKey} />;
}
