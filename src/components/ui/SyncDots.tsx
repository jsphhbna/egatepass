import type { HTMLAttributes } from 'react';

export interface SyncDotsProps extends HTMLAttributes<HTMLDivElement> {
  label?: string;
  ariaLabel?: string;
  size?: 'xs' | 'sm' | 'md';
  color?: 'brand' | 'emerald' | 'amber' | 'neutral' | 'white';
  className?: string;
}

export function SyncDots({
  label,
  ariaLabel,
  size = 'sm',
  color = 'brand',
  className = '',
  ...props
}: SyncDotsProps) {
  const dotSizeClasses = {
    xs: 'h-1.5 w-1.5',
    sm: 'h-2 w-2',
    md: 'h-2.5 w-2.5',
  }[size];

  const dotColorClasses = {
    brand: 'bg-[var(--color-brand)]',
    emerald: 'bg-emerald-600',
    amber: 'bg-amber-500',
    neutral: 'bg-[var(--color-text-secondary)]',
    white: 'bg-white',
  }[color];

  return (
    <div
      role="status"
      aria-live="polite"
      aria-label={label ? undefined : ariaLabel || 'Syncing…'}
      className={`inline-flex items-center gap-2 ${className}`.trim()}
      {...props}
    >
      <div className="inline-flex items-center gap-1" aria-hidden="true">
        <span
          className={`rounded-full ${dotSizeClasses} ${dotColorClasses} animate-pulse-dot`}
          style={{ animationDelay: '0ms' }}
        />
        <span
          className={`rounded-full ${dotSizeClasses} ${dotColorClasses} animate-pulse-dot`}
          style={{ animationDelay: '200ms' }}
        />
        <span
          className={`rounded-full ${dotSizeClasses} ${dotColorClasses} animate-pulse-dot`}
          style={{ animationDelay: '400ms' }}
        />
      </div>
      {label && (
        <span className="text-xs font-medium text-[var(--color-text-secondary)]">
          {label}
        </span>
      )}
    </div>
  );
}
