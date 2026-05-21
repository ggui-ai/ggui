import type { FormFieldProps } from './types';
import { colors } from '../tokens/colors';
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
          color: colors.gray[700],
        }}
      >
        {label}
        {required && (
          <span style={{ color: colors.error[500], marginLeft: '2px' }}>*</span>
        )}
      </label>
      {description && (
        <span
          style={{
            fontSize: fontSize.xs,
            color: colors.gray[500],
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
            color: hasError ? colors.error[500] : colors.gray[500],
          }}
        >
          {error || helperText}
        </span>
      )}
    </div>
  );
}
