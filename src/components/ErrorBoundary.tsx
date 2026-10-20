import { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null,
    errorInfo: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
    this.setState({ errorInfo });
  }

  public render() {
    if (this.state.hasError) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-[var(--color-canvas)] p-4">
          <div className="w-full max-w-xl rounded-2xl border border-[var(--color-danger)] bg-white p-6 shadow-sm sm:p-8" role="alert">
            <p className="text-xs font-bold uppercase tracking-widest text-[var(--color-danger)]">Application error</p>
            <h1 className="mt-2 text-2xl font-bold text-[var(--color-text-primary)]">Something went wrong</h1>
            <p className="mt-2 text-sm leading-relaxed text-[var(--color-text-secondary)]">Refresh the page and try again. If the problem continues, contact the system administrator.</p>
            <button type="button" onClick={() => window.location.reload()} className="mt-5 min-h-11 rounded-md bg-[var(--color-brand)] px-4 text-sm font-semibold text-white hover:bg-[var(--color-brand-dark)]">Refresh Page</button>
            <details className="mt-5 rounded-lg border border-[var(--color-border)] bg-[var(--color-canvas)] p-3 text-xs text-[var(--color-text-secondary)]">
              <summary className="cursor-pointer font-semibold text-[var(--color-text-primary)]">Technical details</summary>
              <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono">{this.state.error?.toString()}{'\n'}{this.state.errorInfo?.componentStack}</pre>
            </details>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
