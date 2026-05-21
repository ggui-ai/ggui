import type { CSSProperties } from 'react';
import type { TagProps } from './types';
import { colors } from '../tokens/colors';
import { fontSize, fontWeight } from '../tokens/typography';

const variantStyles: Record<string, CSSProperties> = {
  default: {
    backgroundColor: colors.gray[100],
    color: colors.gray[700],
    border: `1px solid ${colors.gray[200]}`,
  },
  primary: {
    backgroundColor: colors.primary[50],
    color: colors.primary[700],
    border: `1px solid ${colors.primary[200]}`,
  },
  success: {
    backgroundColor: colors.success[50],
    color: colors.success[700],
    border: `1px solid ${colors.success[200]}`,
  },
  warning: {
    backgroundColor: colors.warning[50],
    color: colors.warning[700],
    border: `1px solid ${colors.warning[200]}`,
  },
  error: {
    backgroundColor: colors.error[50],
    color: colors.error[700],
    border: `1px solid ${colors.error[200]}`,
  },
  info: {
    backgroundColor: colors.info[50],
    color: colors.info[700],
    border: `1px solid ${colors.info[200]}`,
  },
};

const sizeStyles: Record<string, CSSProperties> = {
  sm: { padding: '2px 6px', fontSize: fontSize.xs, gap: '4px' },
  md: { padding: '4px 8px', fontSize: fontSize.xs, gap: '6px' },
  lg: { padding: '6px 10px', fontSize: fontSize.sm, gap: '6px' },
};

/**
 * Tag - A label with optional close button for categories, filters, or selections
 */
export function Tag({
  children,
  variant = 'default',
  size = 'md',
  closable,
  onClose,
  icon,
  style,
  className,
}: TagProps) {
  const sizeStyle = sizeStyles[size];

  return (
    <span
      className={className}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: sizeStyle.gap,
        padding: sizeStyle.padding,
        fontSize: sizeStyle.fontSize,
        fontWeight: fontWeight.medium,
        borderRadius: '6px',
        ...variantStyles[variant],
        ...style,
      }}
    >
      {icon && <span style={{ display: 'flex' }}>{icon}</span>}
      {children}
      {closable && (
        <button
          onClick={onClose}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 0,
            border: 'none',
            background: 'none',
            color: 'inherit',
            cursor: 'pointer',
            opacity: 0.7,
            marginLeft: '2px',
          }}
          aria-label="Remove"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor">
            <path d="M9.5 3.205L8.795 2.5 6 5.295 3.205 2.5l-.705.705L5.295 6 2.5 8.795l.705.705L6 6.705 8.795 9.5l.705-.705L6.705 6 9.5 3.205z" />
          </svg>
        </button>
      )}
    </span>
  );
}
