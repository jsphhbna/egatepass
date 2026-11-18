import { Skeleton } from './Skeleton';

export interface CardGridSkeletonProps {
  count?: number;
  columnsClassName?: string;
  className?: string;
  ariaLabel?: string;
  variant?: 'device' | 'queue' | 'generic';
}

export function CardGridSkeleton({
  count = 6,
  columnsClassName = 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3',
  className = '',
  ariaLabel = 'Loading cards...',
  variant = 'generic',
}: CardGridSkeletonProps) {
  return (
    <div
      role="status"
      aria-label={ariaLabel}
      aria-busy="true"
      className={`grid gap-5 ${columnsClassName} ${className}`.trim()}
    >
      {Array.from({ length: count }).map((_, index) => (
        <div
          key={index}
          className="flex flex-col justify-between rounded-xl border border-[var(--color-border)] bg-white p-5 shadow-sm"
          aria-hidden="true"
        >
          <div className="space-y-4">
            {/* Header: Icon + Title + Status Badge */}
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-center gap-3">
                <Skeleton
                  variant={variant === 'device' ? 'rectangular' : 'circular'}
                  className="h-10 w-10 shrink-0"
                />
                <div className="space-y-1.5">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
              <Skeleton className="h-6 w-16 rounded-full" />
            </div>

            {/* Content Body Lines */}
            <div className="space-y-2 pt-2">
              <Skeleton className="h-3 w-5/6" />
              <Skeleton className="h-3 w-2/3" />
              {variant === 'device' && <Skeleton className="h-3 w-1/2" />}
            </div>
          </div>

          {/* Card Footer: Action button or timestamp */}
          <div className="mt-5 flex items-center justify-between border-t border-[var(--color-border)]/60 pt-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-8 w-20 rounded-lg" />
          </div>
        </div>
      ))}
    </div>
  );
}
