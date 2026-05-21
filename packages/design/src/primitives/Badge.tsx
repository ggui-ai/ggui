import type { CSSProperties } from 'react';
import type { BadgeProps } from './types';

const variantStyles: Record<string, CSSProperties> = {
  default: {
    backgroundColor: 'var(--ggui-color-surfaceVariant, #f4f4f5)',
    color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
  },
  primary: {
    backgroundColor: 'var(--ggui-color-primary-100, #e0f2fe)',
    color: 'var(--ggui-color-primary-700, #0369a1)',
  },
  secondary: {
    backgroundColor: 'var(--ggui-color-outlineVariant, #e4e4e7)',
    color: 'var(--ggui-color-onSurface, #18181b)',
  },
  success: {
    backgroundColor: 'var(--ggui-color-success-100, #dcfce7)',
    color: 'var(--ggui-color-success-700, #15803d)',
  },
  warning: {
    backgroundColor: 'var(--ggui-color-warning-100, #fef3c7)',
    color: 'var(--ggui-color-warning-700, #b45309)',
  },
  error: {
    backgroundColor: 'var(--ggui-color-error-100, #fee2e2)',
    color: 'var(--ggui-color-error-700, #b91c1c)',
  },
  info: {
    backgroundColor: 'var(--ggui-color-info-100, #cffafe)',
    color: 'var(--ggui-color-info-700, #0e7490)',
  },
};

const sizeStyles: Record<string, CSSProperties> = {
  sm: { padding: '2px 6px', fontSize: 'var(--ggui-font-size-xs, 12px)' },
  md: { padding: '2px 8px', fontSize: 'var(--ggui-font-size-xs, 12px)' },
  lg: { padding: '4px 10px', fontSize: 'var(--ggui-font-size-sm, 14px)' },
};

/**
 * Badge - A small label for status, counts, or categories
 */
export function Badge({
  children,
  variant = 'default',
  size = 'md',
  pill = true,
  style,
  className,
}: BadgeProps) {
  return (
    <span
      className={className}
      style={{
        ...variantStyles[variant],
        ...sizeStyles[size],
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontWeight: 'var(--ggui-font-weight-medium, 500)' as CSSProperties['fontWeight'],
        borderRadius: pill ? '9999px' : 'var(--ggui-shape-radius-sm, 4px)',
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  );
}
