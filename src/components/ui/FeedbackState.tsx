import { ProgressBar } from './ProgressBar';

interface LoadingStateProps {
  label?: string;
  className?: string;
}

export function LoadingState({ label = 'Loading', className = '' }: LoadingStateProps) {
  return (
    <div className={`flex min-h-32 flex-col items-center justify-center gap-3 text-center px-4 ${className}`.trim()} role="status" aria-live="polite">
      <div className="relative flex h-12 w-12 items-center justify-center">
        <span className="absolute -inset-1.5 rounded-full bg-[var(--color-brand)]/10 animate-pulse" aria-hidden="true" />
        <img src="/earist-logo.png" alt="EARIST seal" className="relative h-10 w-10 object-contain" />
      </div>
      <div className="w-36">
        <ProgressBar indeterminate variant="brand" size="xs" />
      </div>
      <p className="text-xs font-semibold text-[var(--color-text-secondary)]">{label}</p>
    </div>
  );
}
