import type { CSSProperties } from 'react';
import type { ButtonProps } from './types';
import { Spinner } from './Spinner';
import { duration, easing } from '../tokens/transitions';

const sizeStyles: Record<string, CSSProperties> = {
  xs: {
    padding: 'var(--ggui-spacing-1, 4px) var(--ggui-spacing-2, 8px)',
    fontSize: 'var(--ggui-font-size-xs, 12px)',
    minHeight: '24px',
  },
  sm: {
    padding: '6px var(--ggui-spacing-4, 12px)',
    fontSize: 'var(--ggui-font-size-sm, 14px)',
    minHeight: '32px',
  },
  md: {
    padding: '10px var(--ggui-spacing-4, 16px)',
    fontSize: 'var(--ggui-font-size-sm, 14px)',
    minHeight: '40px',
  },
  lg: {
    padding: '12px var(--ggui-spacing-6, 24px)',
    fontSize: 'var(--ggui-font-size-base, 16px)',
    minHeight: '48px',
  },
};

const variantStyles: Record<string, CSSProperties> = {
  primary: {
    backgroundColor: 'var(--ggui-color-primary-600, #0284c7)',
    color: '#ffffff',
    border: 'none',
  },
  secondary: {
    backgroundColor: 'var(--ggui-color-surfaceVariant, #f4f4f5)',
    color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
    border: 'none',
  },
  outline: {
    backgroundColor: 'transparent',
    color: 'var(--ggui-color-primary-600, #0284c7)',
    border: '1px solid var(--ggui-color-primary-600, #0284c7)',
  },
  ghost: {
    backgroundColor: 'transparent',
    color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
    border: 'none',
  },
  danger: {
    backgroundColor: 'var(--ggui-color-error-600, #dc2626)',
    color: '#ffffff',
    border: 'none',
  },
};

/**
 * Button - A clickable button primitive with multiple variants and sizes
 */
export function Button({
  children,
  variant = 'primary',
  size = 'md',
  fullWidth,
  loading,
  disabled,
  leftIcon,
  rightIcon,
  type = 'button',
  onClick,
  onPress,
  style,
  className,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const handleClick = onClick ?? (onPress as ButtonProps['onClick']);

  return (
    <button
      type={type}
      onClick={isDisabled ? undefined : handleClick}
      disabled={isDisabled}
      className={className}
      style={{
        ...sizeStyles[size],
        ...variantStyles[variant],
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 'var(--ggui-spacing-2, 8px)',
        borderRadius: 'var(--ggui-shape-radius-md, 8px)',
        fontWeight: 'var(--ggui-font-weight-medium, 500)',
        cursor: isDisabled ? 'not-allowed' : 'pointer',
        opacity: isDisabled ? 0.5 : 1,
        width: fullWidth ? '100%' : undefined,
        transition: `background-color ${duration.normal} ${easing.easeInOut}, box-shadow ${duration.normal} ${easing.easeInOut}, opacity ${duration.normal} ${easing.easeInOut}`,
        boxShadow: 'var(--ggui-shape-shadow-sm, 0 1px 2px rgba(0,0,0,0.05))',
        ...style,
      }}
      {...rest}
    >
      {loading ? (
        <Spinner size={16} tone="inherit" />
      ) : (
        <>
          {leftIcon}
          {children}
          {rightIcon}
        </>
      )}
    </button>
  );
}
