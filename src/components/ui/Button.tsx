import { ButtonHTMLAttributes, forwardRef, ReactNode } from 'react';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'destructive' | 'destructive-outline' | 'success';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  icon?: ReactNode;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className = '', variant = 'primary', size = 'md', icon, children, disabled, loading, ...props }, ref) => {
    const baseStyles = 'inline-flex items-center justify-center gap-2 rounded-md font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50';
    
    const sizeStyles = {
      sm: 'min-h-10 px-3 py-2 text-sm',
      md: 'min-h-11 px-4 py-2.5 text-sm',
      lg: 'min-h-12 px-6 py-3 text-base',
    };

    const variantStyles = {
      primary: 'bg-[var(--color-brand)] text-white shadow-sm hover:bg-[var(--color-brand-dark)]',
      secondary: 'border border-[var(--color-border-strong)] bg-white text-[var(--color-text-primary)] hover:border-[var(--color-brand)] hover:bg-[var(--color-brand-light)] hover:text-[var(--color-brand)]',
      ghost: 'bg-transparent text-[var(--color-text-secondary)] hover:bg-[var(--color-brand-light)] hover:text-[var(--color-brand)]',
      destructive: 'bg-[var(--color-danger)] text-white shadow-sm hover:bg-[var(--color-danger-dark)]',
      'destructive-outline': 'border border-[var(--color-danger)] bg-white text-[var(--color-danger)] hover:bg-[var(--color-danger-light)]',
      success: 'bg-[var(--color-success)] text-white shadow-sm hover:bg-[var(--color-success-dark)]',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`${baseStyles} ${sizeStyles[size]} ${variantStyles[variant]} ${className}`.trim()}
        {...props}
      >
        {loading ? (
          <span className="h-4 w-4 flex-shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent" aria-hidden="true" />
        ) : icon ? (
          <span className="flex-shrink-0">{icon}</span>
        ) : null}
        {children}
      </button>
    );
  }
);
Button.displayName = 'Button';
