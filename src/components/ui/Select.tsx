import { SelectHTMLAttributes, forwardRef } from 'react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  error?: boolean;
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = '', error, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        aria-invalid={error || undefined}
        className={`box-border min-h-11 w-full min-w-0 max-w-full rounded-md border bg-white px-3.5 py-2.5 text-base sm:text-sm text-[var(--color-text-primary)] shadow-xs transition-colors focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-[var(--color-overlay)] disabled:opacity-70 ${
          error ? 'border-[var(--color-danger)] focus:border-[var(--color-danger)] focus:ring-[var(--color-danger)]' : 'border-[var(--color-border-strong)] focus:border-[var(--color-brand)] focus:ring-[var(--color-brand)]'
        } ${className}`.trim()}
        {...props}
      >
        {children}
      </select>
    );
  }
);
Select.displayName = 'Select';
