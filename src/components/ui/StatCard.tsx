import { ReactNode } from 'react';
import { Card } from './Card';

interface StatCardProps {
  title: string;
  value: string | number;
  icon: ReactNode;
  description?: string;
  trend?: string;
  trendUp?: boolean;
}

export function StatCard({ title, value, icon, description, trend, trendUp }: StatCardProps) {
  return (
    <Card className="flex h-full items-start p-5 sm:p-6">
      <div className="mr-4 flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--color-canvas)] text-[var(--color-earist-maroon)]">
        {icon}
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--color-text-secondary)]">{title}</p>
        <p className="text-2xl font-bold text-[var(--color-text-primary)]">{value}</p>
        {description && (
          <p className="mt-1 text-xs leading-relaxed text-[var(--color-text-muted)]">{description}</p>
        )}
        {trend && (
          <p className={`text-xs mt-1 ${trendUp ? 'text-[var(--color-success)]' : 'text-[var(--color-danger)]'}`}>
            {trend}
          </p>
        )}
      </div>
    </Card>
  );
}
