import { useId } from 'react';
import type { CSSProperties } from 'react';
import type { InputProps } from './types';
import { duration, easing } from '../tokens/transitions';

const sizeStyles: Record<string, CSSProperties> = {
  sm: {
    padding: '6px 10px',
    fontSize: 'var(--ggui-font-size-sm, 14px)',
  },
  md: {
    padding: '10px 12px',
    fontSize: 'var(--ggui-font-size-sm, 14px)',
  },
  lg: {
    padding: '12px 14px',
    fontSize: 'var(--ggui-font-size-base, 16px)',
  },
};

/**
 * Input - A text input primitive with label, error, and helper text support
 *
 * IMPORTANT: onChange receives the value directly, not an event!
 * Example: onChange={(value) => setValue(value)} or onChange={setValue}
 */
export function Input({
  label,
  placeholder,
  value,
  onChange,
  type = 'text',
  error,
  helperText,
  required,
  disabled,
  size = 'md',
  style,
  className,
  ...rest
}: InputProps) {
  const uniqueId = useId();
  const inputId = `${uniqueId}-input`;
  const messageId = `${uniqueId}-message`;
  const hasError = Boolean(error);
  const hasMessage = Boolean(error || helperText);

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--ggui-spacing-1, 4px)',
        ...style,
      }}
    >
      {label && (
        <label
          htmlFor={inputId}
          style={{
            fontSize: 'var(--ggui-font-size-sm, 14px)',
            fontWeight: 'var(--ggui-font-weight-medium, 500)',
            color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
          }}
        >
          {label}
          {required && (
            <span aria-hidden="true" style={{ color: 'var(--ggui-color-error-500, #ef4444)', marginLeft: '2px' }}>*</span>
          )}
        </label>
      )}
      <input
        id={inputId}
        type={type}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        disabled={disabled}
        required={required}
        aria-invalid={hasError || undefined}
        aria-describedby={hasMessage ? messageId : undefined}
        style={{
          ...sizeStyles[size],
          width: '100%',
          borderRadius: 'var(--ggui-shape-radius-md, 8px)',
          border: `1px solid ${
            hasError
              ? 'var(--ggui-color-error-500, #ef4444)'
              : 'var(--ggui-color-outline, #d4d4d8)'
          }`,
          backgroundColor: disabled
            ? 'var(--ggui-color-surface, #fafafa)'
            : 'var(--ggui-color-surface, #ffffff)',
          color: 'var(--ggui-color-onSurface, #18181b)',
          transition: `border-color ${duration.normal} ${easing.easeInOut}, box-shadow ${duration.normal} ${easing.easeInOut}`,
          boxSizing: 'border-box',
        }}
        {...rest}
      />
      {hasMessage && (
        <span
          id={messageId}
          role={hasError ? 'alert' : undefined}
          style={{
            fontSize: 'var(--ggui-font-size-xs, 12px)',
            color: hasError
              ? 'var(--ggui-color-error-500, #ef4444)'
              : 'var(--ggui-color-onSurfaceVariant, #52525b)',
          }}
        >
          {error || helperText}
        </span>
      )}
    </div>
  );
}
