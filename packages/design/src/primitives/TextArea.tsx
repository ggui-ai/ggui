import { useId } from 'react';
import type { TextAreaProps } from './types';
import { duration, easing } from '../tokens/transitions';

/**
 * TextArea - A multiline text input primitive
 *
 * IMPORTANT: onChange receives the value directly, not an event!
 * Example: onChange={(value) => setValue(value)} or onChange={setValue}
 */
export function TextArea({
  label,
  placeholder,
  value,
  onChange,
  rows = 4,
  error,
  helperText,
  required,
  disabled,
  maxLength,
  showCount,
  autoResize,
  style,
  className,
  ...rest
}: TextAreaProps) {
  const uniqueId = useId();
  const textareaId = `${uniqueId}-textarea`;
  const messageId = `${uniqueId}-message`;
  const hasError = Boolean(error);
  const hasMessage = Boolean(error || helperText);
  const charCount = value?.length || 0;

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
          htmlFor={textareaId}
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
      <textarea
        id={textareaId}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        rows={rows}
        disabled={disabled}
        required={required}
        maxLength={maxLength}
        aria-invalid={hasError || undefined}
        aria-describedby={hasMessage ? messageId : undefined}
        style={{
          padding: '10px 12px',
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
          fontSize: 'var(--ggui-font-size-sm, 14px)',
          fontFamily: 'inherit',
          transition: `border-color ${duration.normal} ${easing.easeInOut}, box-shadow ${duration.normal} ${easing.easeInOut}`,
          boxSizing: 'border-box',
          resize: autoResize ? 'none' : 'vertical',
        }}
        {...rest}
      />
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
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
        {showCount && maxLength && (
          <span
            style={{
              fontSize: 'var(--ggui-font-size-xs, 12px)',
              color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
              marginLeft: 'auto',
            }}
          >
            {charCount}/{maxLength}
          </span>
        )}
      </div>
    </div>
  );
}
