import type { MouseEvent } from 'react';
import { ChevronDown, KeyRound, UserRound } from 'lucide-react';

interface GuardAccountMenuProps {
  name: string;
  onResetPassword: () => void;
}

export function GuardAccountMenu({ name, onResetPassword }: GuardAccountMenuProps) {
  function handleResetPassword(event: MouseEvent<HTMLButtonElement>) {
    event.currentTarget.closest('details')?.removeAttribute('open');
    onResetPassword();
  }

  return (
    <details className="group relative">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-md border border-[var(--color-border)] bg-white px-3 text-sm font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-canvas)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)] [&::-webkit-details-marker]:hidden">
        <UserRound className="h-4 w-4 text-[var(--color-text-secondary)]" aria-hidden="true" />
        <span className="max-w-40 truncate">{name}</span>
        <ChevronDown className="h-4 w-4 text-[var(--color-text-muted)] transition-transform group-open:rotate-180" aria-hidden="true" />
      </summary>
      <div className="absolute right-0 z-20 mt-2 w-52 rounded-lg border border-[var(--color-border)] bg-white p-1.5 shadow-lg">
        <button
          type="button"
          onClick={handleResetPassword}
          className="flex min-h-11 w-full items-center gap-2 rounded-md px-3 text-left text-sm font-medium text-[var(--color-text-primary)] hover:bg-[var(--color-brand-light)] hover:text-[var(--color-brand)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-brand)]"
        >
          <KeyRound className="h-4 w-4" aria-hidden="true" />
          Reset Password
        </button>
      </div>
    </details>
  );
}
