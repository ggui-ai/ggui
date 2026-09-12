import type { FormFieldProps } from './types';
import { fontSize, fontWeight } from '../tokens/typography';

/**
 * FormField - A wrapper that adds label, description, error, and helper text to form inputs
 */
export function FormField({
  label,
  children,
  error,
  helperText,
  required,
  description,
  style,
  className,
}: FormFieldProps) {
  const hasError = Boolean(error);

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '4px',
        ...style,
      }}
    >
      <label
        style={{
          fontSize: fontSize.sm,
          fontWeight: fontWeight.medium,
          color: 'var(--ggui-color-onContainer, #374151)',
        }}
      >
        {label}
        {required && (
          <span style={{ color: 'var(--ggui-color-error-500, #ef4444)', marginLeft: '2px' }}>*</span>
        )}
      </label>
      {description && (
        <span
          style={{
            fontSize: fontSize.xs,
            color: 'var(--ggui-color-neutral-500, #6b7280)',
            marginBottom: '4px',
          }}
        >
          {description}
        </span>
      )}
      {children}
      {(error || helperText) && (
        <span
          style={{
            fontSize: fontSize.xs,
            color: hasError ? 'var(--ggui-color-error-500, #ef4444)' : 'var(--ggui-color-neutral-500, #6b7280)',
          }}
        >
          {error || helperText}
        </span>
      )}
    </div>
  );
}
