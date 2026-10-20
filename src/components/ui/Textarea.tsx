import { TextareaHTMLAttributes, forwardRef } from 'react';

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  error?: boolean;
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = '', error, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        aria-invalid={error || undefined}
        className={`min-h-24 w-full resize-y rounded-md border bg-white px-3.5 py-2.5 text-sm text-[var(--color-text-primary)] shadow-xs transition-colors placeholder:text-[var(--color-text-muted)] focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:bg-[var(--color-overlay)] disabled:opacity-70 ${
          error ? 'border-[var(--color-danger)] focus:border-[var(--color-danger)] focus:ring-[var(--color-danger)]' : 'border-[var(--color-border-strong)] focus:border-[var(--color-brand)] focus:ring-[var(--color-brand)]'
        } ${className}`.trim()}
        {...props}
      />
    );
  }
);
Textarea.displayName = 'Textarea';
