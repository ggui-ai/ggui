import { useId } from 'react';
import type { CSSProperties } from 'react';
import type { SelectProps } from './types';
import { duration, easing } from '../tokens/transitions';

const sizeStyles: Record<string, CSSProperties> = {
  sm: { padding: '6px 10px', fontSize: 'var(--ggui-font-size-sm, 14px)' },
  md: { padding: '10px 12px', fontSize: 'var(--ggui-font-size-sm, 14px)' },
  lg: { padding: '12px 14px', fontSize: 'var(--ggui-font-size-base, 16px)' },
};

/**
 * Select - A dropdown selection primitive
 *
 * IMPORTANT: onChange receives the value directly, not an event!
 * Example: onChange={(value) => setValue(value)} or onChange={setValue}
 */
export function Select({
  label,
  value,
  onChange,
  options,
  placeholder,
  error,
  helperText,
  required,
  disabled,
  size = 'md',
  style,
  className,
  ...rest
}: SelectProps) {
  const uniqueId = useId();
  const selectId = `${uniqueId}-select`;
  const messageId = `${uniqueId}-message`;
  const hasError = Boolean(error);
  const hasMessage = Boolean(error || helperText);

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ggui-spacing-1, 4px)', ...style }}>
      {label && (
        <label
          htmlFor={selectId}
          style={{
            fontSize: 'var(--ggui-font-size-sm, 14px)',
            fontWeight: 'var(--ggui-font-weight-medium, 500)',
            color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
          }}
        >
          {label}
          {required && <span aria-hidden="true" style={{ color: 'var(--ggui-color-error-500, #ef4444)', marginLeft: '2px' }}>*</span>}
        </label>
      )}
      <select
        id={selectId}
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
          border: `1px solid ${hasError ? 'var(--ggui-color-error-500, #ef4444)' : 'var(--ggui-color-outline, #d4d4d8)'}`,
          backgroundColor: disabled ? 'var(--ggui-color-surface, #fafafa)' : 'var(--ggui-color-surface, #ffffff)',
          color: value ? 'var(--ggui-color-onSurface, #18181b)' : 'var(--ggui-color-onSurfaceVariant, #52525b)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          appearance: 'none',
          backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b7280' d='M3 4.5L6 7.5L9 4.5'/%3E%3C/svg%3E")`,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 12px center',
          paddingRight: '36px',
          boxSizing: 'border-box',
          transition: `border-color ${duration.normal} ${easing.easeInOut}, box-shadow ${duration.normal} ${easing.easeInOut}`,
        }}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </option>
        ))}
      </select>
      {hasMessage && (
        <span
          id={messageId}
          role={hasError ? 'alert' : undefined}
          style={{
            fontSize: 'var(--ggui-font-size-xs, 12px)',
            color: hasError ? 'var(--ggui-color-error-500, #ef4444)' : 'var(--ggui-color-onSurfaceVariant, #52525b)',
          }}
        >
          {error || helperText}
        </span>
      )}
    </div>
  );
}
