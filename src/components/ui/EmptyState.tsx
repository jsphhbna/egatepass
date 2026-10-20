import { ReactNode } from 'react';

interface EmptyStateProps {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className = '' }: EmptyStateProps) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-surface)] p-8 text-center ${className}`.trim()}>
      <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--color-neutral-light)] text-[var(--color-text-muted)]">
        {icon}
      </div>
      <h3 className="mb-2 text-lg font-bold text-[var(--color-text-primary)]">{title}</h3>
      <p className="mb-6 max-w-sm text-sm leading-relaxed text-[var(--color-text-secondary)]">
        {description}
      </p>
      {action}
    </div>
  );
}
