import { InputHTMLAttributes, forwardRef } from 'react';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  error?: boolean;
}

const TEMPORAL_TYPES = new Set(['date', 'time', 'datetime-local', 'month', 'week']);

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', error, type, ...props }, ref) => {
    const isTemporal = type ? TEMPORAL_TYPES.has(type) : false;
    // On iOS Safari, native date/temporal controls add padding to 100% width or miscalculate
    // intrinsic widths, causing narrow-screen horizontal overflow. We apply px-2 on mobile
    // while restoring standard px-3.5 at sm breakpoint. Non-temporal inputs retain full px-3.5.
    const paddingClasses = isTemporal ? 'px-2 sm:px-3.5' : 'px-3.5';

    return (
      <input
        ref={ref}
        type={type}
        aria-invalid={error || undefined}
        className={`box-border min-h-11 w-full min-w-0 max-w-full rounded-md border bg-white ${paddingClasses} py-2.5 text-base sm:text-sm text-[var(--color-text-primary)] shadow-xs transition-colors placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-[var(--color-overlay)] disabled:opacity-70 ${
          error ? 'border-[var(--color-danger)] focus:border-[var(--color-danger)] focus:ring-[var(--color-danger)]' : 'border-[var(--color-border-strong)] focus:border-[var(--color-brand)] focus:ring-[var(--color-brand)]'
        } ${className}`.trim()}
        {...props}
      />
    );
  }
);
Input.displayName = 'Input';
