import type { CSSProperties } from 'react';
import type { TagProps } from './types';
import { fontSize, fontWeight } from '../tokens/typography';

// Every variant paints the THEME's roles (ggui#1036): the neutral tag is the
// sunken surface pair, the toned tags their tone's container pair, the border
// the tone's 200 stop — with the default palette's literal only as the `var()`
// fallback, so an un-themed render is byte-identical to before and a themed
// one follows the app's theme in both modes. Nothing here reads tokens/colors.
const variantStyles: Record<string, CSSProperties> = {
  default: {
    backgroundColor: 'var(--ggui-color-sunken, #f3f4f6)',
    color: 'var(--ggui-color-onSunken, #374151)',
    border: '1px solid var(--ggui-color-outlineVariant, #e5e7eb)',
  },
  primary: {
    backgroundColor: 'var(--ggui-color-primaryContainer, #f0f9ff)',
    color: 'var(--ggui-color-onPrimaryContainer, #0369a1)',
    border: '1px solid var(--ggui-color-primary-200, #bae6fd)',
  },
  success: {
    backgroundColor: 'var(--ggui-color-successContainer, #f0fdf4)',
    color: 'var(--ggui-color-onSuccessContainer, #15803d)',
    border: '1px solid var(--ggui-color-success-200, #bbf7d0)',
  },
  warning: {
    backgroundColor: 'var(--ggui-color-warningContainer, #fffbeb)',
    color: 'var(--ggui-color-onWarningContainer, #b45309)',
    border: '1px solid var(--ggui-color-warning-200, #fde68a)',
  },
  error: {
    backgroundColor: 'var(--ggui-color-errorContainer, #fef2f2)',
    color: 'var(--ggui-color-onErrorContainer, #b91c1c)',
    border: '1px solid var(--ggui-color-error-200, #fecaca)',
  },
  info: {
    backgroundColor: 'var(--ggui-color-infoContainer, #ecfeff)',
    color: 'var(--ggui-color-onInfoContainer, #0e7490)',
    border: '1px solid var(--ggui-color-info-200, #a5f3fc)',
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
