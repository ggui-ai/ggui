import { useId } from 'react';
import type { CSSProperties } from 'react';
import type { RadioGroupProps } from './types';

/**
 * RadioGroup - A group of radio button options
 *
 * IMPORTANT: onChange receives the value directly, not an event!
 * Example: onChange={(value) => setValue(value)} or onChange={setValue}
 */
export function RadioGroup({
  label,
  value,
  onChange,
  options,
  direction = 'vertical',
  disabled,
  error,
  style,
  className,
}: RadioGroupProps) {
  const uniqueId = useId();
  const labelId = `${uniqueId}-label`;
  const errorId = `${uniqueId}-error`;
  const groupName = `${uniqueId}-radio`;
  const hasError = Boolean(error);

  return (
    <div
      role="radiogroup"
      aria-labelledby={label ? labelId : undefined}
      aria-describedby={hasError ? errorId : undefined}
      className={className}
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ggui-spacing-2, 8px)', ...style }}
    >
      {label && (
        <span
          id={labelId}
          style={{
            fontSize: 'var(--ggui-font-size-sm, 14px)',
            fontWeight: 'var(--ggui-font-weight-medium, 500)' as CSSProperties['fontWeight'],
            color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
          }}
        >
          {label}
        </span>
      )}
      <div
        style={{
          display: 'flex',
          flexDirection: direction === 'vertical' ? 'column' : 'row',
          gap: direction === 'vertical' ? 'var(--ggui-spacing-2, 8px)' : 'var(--ggui-spacing-4, 16px)',
          flexWrap: 'wrap',
        }}
      >
        {options.map((option) => {
          const isSelected = value === option.value;
          const isDisabled = disabled || option.disabled;

          return (
            <label
              key={option.value}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 'var(--ggui-spacing-2, 8px)',
                cursor: isDisabled ? 'not-allowed' : 'pointer',
                opacity: isDisabled ? 0.5 : 1,
              }}
            >
              <div
                style={{
                  position: 'relative',
                  width: '18px',
                  height: '18px',
                  flexShrink: 0,
                  marginTop: '2px',
                }}
              >
                <input
                  type="radio"
                  name={groupName}
                  value={option.value}
                  checked={isSelected}
                  onChange={() => onChange?.(option.value)}
                  disabled={isDisabled}
                  style={{
                    position: 'absolute',
                    width: '18px',
                    height: '18px',
                    margin: 0,
                    opacity: 0,
                    cursor: isDisabled ? 'not-allowed' : 'pointer',
                  }}
                />
                <div
                  style={{
                    width: '18px',
                    height: '18px',
                    borderRadius: 'var(--ggui-shape-radius-full, 9999px)',
                    border: `2px solid ${isSelected ? 'var(--ggui-color-primary-600, #0284c7)' : 'var(--ggui-color-outline, #d4d4d8)'}`,
                    backgroundColor: 'var(--ggui-color-surface, #ffffff)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    transition: 'all 0.2s',
                  }}
                >
                  {isSelected && (
                    <div
                      style={{
                        width: '8px',
                        height: '8px',
                        borderRadius: 'var(--ggui-shape-radius-full, 9999px)',
                        backgroundColor: 'var(--ggui-color-primary-600, #0284c7)',
                      }}
                    />
                  )}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                <span
                  style={{
                    fontSize: 'var(--ggui-font-size-sm, 14px)',
                    fontWeight: 'var(--ggui-font-weight-medium, 500)' as CSSProperties['fontWeight'],
                    color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                  }}
                >
                  {option.label}
                </span>
                {option.description && (
                  <span
                    style={{
                      fontSize: 'var(--ggui-font-size-xs, 12px)',
                      color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                    }}
                  >
                    {option.description}
                  </span>
                )}
              </div>
            </label>
          );
        })}
      </div>
      {error && (
        <span
          id={errorId}
          role="alert"
          style={{
            fontSize: 'var(--ggui-font-size-xs, 12px)',
            color: 'var(--ggui-color-error-500, #ef4444)',
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
