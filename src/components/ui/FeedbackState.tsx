interface LoadingStateProps {
  label?: string;
  className?: string;
}

export function LoadingState({ label = 'Loading', className = '' }: LoadingStateProps) {
  return (
    <div className={`flex min-h-32 flex-col items-center justify-center gap-3 text-center ${className}`.trim()} role="status" aria-live="polite">
      <span className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--color-border)] border-t-[var(--color-brand)]" aria-hidden="true" />
      <p className="text-sm font-medium text-[var(--color-text-secondary)]">{label}</p>
    </div>
  );
}
