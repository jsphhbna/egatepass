import { type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';

interface FormFieldProps {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
  id?: string;
  className?: string;
}

export function FormField({ label, error, hint, children, id, className = '' }: FormFieldProps) {
  return (
    <div className={`space-y-1.5 ${className}`.trim()}>
      <label htmlFor={id} className="block text-sm font-semibold text-[var(--color-text-primary)]">
        {label}
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
