export type GatePassStatus = 'issued' | 'pending' | 'inside' | 'exited' | 'expired' | 'rejected';

interface StatusBadgeProps {
  status: GatePassStatus | string;
  label?: string;
  className?: string;
}

export function StatusBadge({ status, label, className = '' }: StatusBadgeProps) {
  const normalizedStatus = status.toLowerCase();
  const baseClasses = 'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 text-xs font-semibold capitalize';
  let badgeClasses = 'border-[var(--color-border)] bg-[var(--color-overlay)] text-[var(--color-text-secondary)]';

  if (['pending', 'processing', 'unverified'].includes(normalizedStatus)) {
    badgeClasses = 'border-[var(--color-warning)] bg-[var(--color-warning-light)] text-[var(--color-warning-dark)]';
  } else if (['inside', 'active', 'approved', 'ready', 'valid', 'verified'].includes(normalizedStatus)) {
    badgeClasses = 'border-[var(--color-success)] bg-[var(--color-success-light)] text-[var(--color-success-dark)]';
  } else if (['rejected', 'revoked', 'error', 'invalid'].includes(normalizedStatus)) {
    badgeClasses = 'border-[var(--color-danger)] bg-[var(--color-danger-light)] text-[var(--color-danger-dark)]';
  } else if (['issued', 'exited', 'inactive'].includes(normalizedStatus)) {
    badgeClasses = 'border-[var(--color-border-strong)] bg-[var(--color-neutral-light)] text-[var(--color-neutral)]';
  } else if (normalizedStatus === 'expired') {
    badgeClasses = 'border-[var(--color-border)] bg-[var(--color-overlay)] text-[var(--color-text-muted)]';
  }

  return (
    <span className={`${baseClasses} ${badgeClasses} ${className}`.trim()}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" aria-hidden="true" />
      {label || status}
    </span>
  );
}
