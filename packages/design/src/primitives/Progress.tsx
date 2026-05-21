import type { CSSProperties } from 'react';
import type { ProgressProps } from './types';

const variantColors: Record<string, string> = {
  default: 'var(--ggui-color-primary-600, #0284c7)',
  success: 'var(--ggui-color-success-500, #22c55e)',
  warning: 'var(--ggui-color-warning-500, #f59e0b)',
  error: 'var(--ggui-color-error-500, #ef4444)',
};

const sizeHeights: Record<string, number> = {
  sm: 4,
  md: 8,
  lg: 12,
};

/**
 * Progress - A progress bar indicator
 */
export function Progress({
  value,
  max = 100,
  variant = 'default',
  size = 'md',
  label,
  showLabel,
  indeterminate,
  style,
  className,
}: ProgressProps) {
  const percentage = Math.min(100, Math.max(0, (value / max) * 100));
  const height = sizeHeights[size];
  const barColor = variantColors[variant];
  const accessibleName = label ?? 'Progress';

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ggui-spacing-1, 4px)', ...style }}>
      {showLabel && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 'var(--ggui-font-size-sm, 14px)', color: 'var(--ggui-color-onSurfaceVariant, #52525b)' }}>{accessibleName}</span>
          <span style={{
            fontSize: 'var(--ggui-font-size-sm, 14px)',
            fontWeight: 'var(--ggui-font-weight-medium, 500)' as CSSProperties['fontWeight'],
            color: 'var(--ggui-color-onSurface, #18181b)',
          }}>
            {Math.round(percentage)}%
          </span>
        </div>
      )}
      <div
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : value}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-label={accessibleName}
        style={{
          width: '100%',
          height,
          borderRadius: height / 2,
          backgroundColor: 'var(--ggui-color-outlineVariant, #e4e4e7)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            borderRadius: height / 2,
            backgroundColor: barColor,
            transition: indeterminate ? 'none' : 'width 0.3s ease',
            ...(indeterminate
              ? {
                  width: '30%',
                  animation: 'ggui-progress-indeterminate 1.5s ease-in-out infinite',
                }
              : {
                  width: `${percentage}%`,
                }),
          }}
        />
        {indeterminate && (
          <style>
            {`@keyframes ggui-progress-indeterminate {
              0% { transform: translateX(-100%); }
              100% { transform: translateX(400%); }
            }`}
          </style>
        )}
      </div>
    </div>
  );
}
