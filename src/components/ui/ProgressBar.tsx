import type { HTMLAttributes } from 'react';

export interface ProgressBarProps extends HTMLAttributes<HTMLDivElement> {
  value?: number;
  indeterminate?: boolean;
  label?: string;
  phase?: string;
  showPercentage?: boolean;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  variant?: 'brand' | 'accent' | 'success' | 'warning' | 'danger';
  className?: string;
}

export function ProgressBar({
  value = 0,
  indeterminate = false,
  label,
  phase,
  showPercentage = false,
  size = 'md',
  variant = 'brand',
  className = '',
  ...props
}: ProgressBarProps) {
  const numericValue = Number.isFinite(value) ? value : 0;
  const clampedValue = Math.min(100, Math.max(0, Math.round(numericValue)));

  const sizeClasses = {
    xs: 'h-1',
    sm: 'h-2',
    md: 'h-3',
    lg: 'h-4',
  }[size];

  const variantBarClasses = {
    brand: 'bg-[var(--color-brand)]',
    accent: 'bg-[var(--color-accent)]',
    success: 'bg-[var(--color-success)]',
    warning: 'bg-[var(--color-warning)]',
    danger: 'bg-[var(--color-danger)]',
  }[variant];

  return (
    <div
      role="progressbar"
      aria-label={label || 'Progress'}
      aria-valuenow={indeterminate ? undefined : clampedValue}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuetext={phase || (indeterminate ? 'In progress' : `${clampedValue}%`)}
      className={`w-full space-y-1.5 ${className}`.trim()}
      {...props}
    >
      {(label || phase || showPercentage) && (
        <div className="flex items-center justify-between text-xs text-[var(--color-text-secondary)] font-medium">
          <div className="truncate pr-2">
            {label && <span className="font-semibold text-[var(--color-text-primary)]">{label}</span>}
            {label && phase && <span className="mx-1.5 text-[var(--color-border-strong)]">•</span>}
            {phase && <span>{phase}</span>}
          </div>
          {!indeterminate && showPercentage && (
            <span className="tabular-nums font-semibold text-[var(--color-text-primary)]">
              {clampedValue}%
            </span>
          )}
        </div>
      )}

      <div
        className={`relative w-full overflow-hidden rounded-full bg-[var(--color-border)]/60 ${sizeClasses}`}
      >
        {indeterminate ? (
          <div
            className={`absolute inset-y-0 w-1/2 rounded-full ${variantBarClasses} animate-progress-indeterminate`}
          />
        ) : (
          <div
            className={`h-full rounded-full transition-all duration-300 ease-out ${variantBarClasses}`}
            style={{ width: `${clampedValue}%` }}
          />
        )}
      </div>
    </div>
  );
}
