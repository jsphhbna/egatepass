import type { HTMLAttributes, CSSProperties } from 'react';

export interface SkeletonProps extends HTMLAttributes<HTMLDivElement> {
  className?: string;
  variant?: 'text' | 'rectangular' | 'circular';
  width?: string | number;
  height?: string | number;
  animate?: boolean;
}

export function Skeleton({
  className = '',
  variant = 'rectangular',
  width,
  height,
  animate = true,
  style,
  ...props
}: SkeletonProps) {
  const variantClasses = {
    text: 'h-4 rounded-sm w-full',
    rectangular: 'rounded-md',
    circular: 'rounded-full',
  }[variant];

  const animationClass = animate ? 'animate-shimmer' : 'bg-[var(--color-border)]';

  const inlineStyle: CSSProperties = {
    ...(width !== undefined ? { width: typeof width === 'number' ? `${width}px` : width } : {}),
    ...(height !== undefined ? { height: typeof height === 'number' ? `${height}px` : height } : {}),
    ...style,
  };

  return (
    <div
      aria-hidden="true"
      className={`border border-[var(--color-border)]/40 ${variantClasses} ${animationClass} ${className}`.trim()}
      style={inlineStyle}
      {...props}
    />
  );
}
