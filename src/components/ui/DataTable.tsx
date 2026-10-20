import { ReactNode } from 'react';

interface DataTableProps {
  children: ReactNode;
  className?: string;
}

export function DataTable({ children, className = '' }: DataTableProps) {
  return (
    <div className={`max-w-full overflow-x-auto rounded-xl border border-[var(--color-border)] bg-white shadow-sm ${className}`.trim()}>
      <table className="w-full min-w-max text-left text-sm">
        {children}
      </table>
    </div>
  );
}

export function DataTableHead({ children }: { children: ReactNode }) {
  return (
    <thead className="border-b border-[var(--color-border)] bg-[var(--color-overlay)] text-xs uppercase tracking-wide text-[var(--color-text-secondary)]">
      {children}
    </thead>
  );
}

export function DataTableRow({ children, className = '' }: { children: ReactNode, className?: string }) {
  return (
    <tr className={`border-b border-[var(--color-border)] transition-colors last:border-0 hover:bg-[var(--color-canvas)] ${className}`.trim()}>
      {children}
    </tr>
  );
}

export function DataTableCell({ children, className = '', isHeader = false }: { children: ReactNode, className?: string, isHeader?: boolean }) {
  const Component = isHeader ? 'th' : 'td';
  return (
    <Component className={`px-4 py-3.5 ${isHeader ? 'font-bold' : 'text-[var(--color-text-primary)]'} ${className}`.trim()}>
      {children}
    </Component>
  );
}
