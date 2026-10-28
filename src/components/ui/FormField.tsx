import { type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

export interface FormFieldProps {
  label: string;
  requirement?: 'required' | 'optional' | 'none';
  error?: string;
  hint?: string;
  children: ReactNode;
  id?: string;
  className?: string;
}

export function FormField({
  label,
  requirement = 'none',
  error,
  hint,
  children,
  id,
  className = '',
}: FormFieldProps) {
  return (
    <div className={`min-w-0 space-y-1.5 ${className}`.trim()}>
      <label htmlFor={id} className="block text-sm font-semibold text-[var(--color-text-primary)]">
        <span>{label}</span>
        {requirement === 'required' && (
          <>
            <span className="text-[var(--color-danger)] font-bold ml-1" aria-hidden="true">*</span>
            <span className="sr-only"> (required)</span>
          </>
        )}
        {requirement === 'optional' && (
          <span className="text-[var(--color-text-muted)] font-normal ml-1 text-xs">
            (Optional)
          </span>
        )}
      </label>
      {children}
      {hint && !error && (
        <p className="text-xs leading-relaxed text-[var(--color-text-secondary)]">{hint}</p>
      )}
      {error && (
        <p className="mt-1 flex items-start gap-1.5 text-xs font-medium leading-relaxed text-[var(--color-danger)]" role="alert">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
