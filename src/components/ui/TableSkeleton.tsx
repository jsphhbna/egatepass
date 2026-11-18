import { Skeleton } from './Skeleton';

export interface TableSkeletonProps {
  columns?: number;
  rows?: number;
  asRows?: boolean;
  columnWidths?: (string | number)[];
  showHeader?: boolean;
  className?: string;
  ariaLabel?: string;
}

export function TableSkeletonRows({
  columns = 6,
  rows = 8,
  columnWidths,
  ariaLabel,
}: {
  columns?: number;
  rows?: number;
  columnWidths?: (string | number)[];
  ariaLabel?: string;
}) {
  return (
    <>
      {ariaLabel && (
        <tr className="sr-only">
          <td colSpan={columns} role="status" aria-live="polite">
            {ariaLabel}
          </td>
        </tr>
      )}
      {Array.from({ length: rows }).map((_, rowIndex) => (
        <tr
          key={rowIndex}
          className="border-b border-[var(--color-border)] last:border-0"
          aria-hidden="true"
        >
          {Array.from({ length: columns }).map((_, colIndex) => {
            const width = columnWidths?.[colIndex];
            // Provide varied realistic bar widths if no explicit width
            const widthClass =
              width !== undefined
                ? ''
                : colIndex === 0
                ? 'w-3/4'
                : colIndex === columns - 1
                ? 'w-16 ml-auto'
                : colIndex % 2 === 0
                ? 'w-2/3'
                : 'w-1/2';

            return (
              <td key={colIndex} className="px-4 py-3.5">
                <Skeleton
                  className={`h-4 ${widthClass}`}
                  style={width !== undefined ? { width: typeof width === 'number' ? `${width}px` : width } : undefined}
                />
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}

export function TableSkeleton({
  columns = 6,
  rows = 8,
  asRows = false,
  columnWidths,
  showHeader = true,
  className = '',
  ariaLabel = 'Loading table records...',
}: TableSkeletonProps) {
  if (asRows) {
    return <TableSkeletonRows columns={columns} rows={rows} columnWidths={columnWidths} />;
  }

  return (
    <div
      role="status"
      aria-label={ariaLabel}
      aria-busy="true"
      className={`max-w-full overflow-x-auto rounded-xl border border-[var(--color-border)] bg-white shadow-sm ${className}`.trim()}
    >
      <table className="w-full min-w-max text-left text-sm">
        {showHeader && (
          <thead className="border-b border-[var(--color-border)] bg-[var(--color-overlay)] text-xs uppercase tracking-wide">
            <tr>
              {Array.from({ length: columns }).map((_, index) => (
                <th key={index} className="px-4 py-3.5">
                  <Skeleton className="h-3.5 w-20" />
                </th>
              ))}
            </tr>
          </thead>
        )}
        <tbody>
          <TableSkeletonRows columns={columns} rows={rows} columnWidths={columnWidths} />
        </tbody>
      </table>
    </div>
  );
}
