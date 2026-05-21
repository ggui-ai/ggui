import type { CSSProperties } from 'react';
import type { CheckboxProps } from './types';

/**
 * Checkbox - A checkbox input primitive
 *
 * IMPORTANT: onChange receives the boolean value directly!
 * Example: onChange={(checked) => setChecked(checked)} or onChange={setChecked}
 */
export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  description,
  indeterminate,
  style,
  className,
}: CheckboxProps) {
  return (
    <label
      className={className}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 'var(--ggui-spacing-2, 8px)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        ...style,
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
          type="checkbox"
          checked={checked}
          onChange={(e) => onChange?.(e.target.checked)}
          disabled={disabled}
          ref={(el) => {
            if (el) el.indeterminate = indeterminate || false;
          }}
          style={{
            position: 'absolute',
            width: '18px',
            height: '18px',
            margin: 0,
            opacity: 0,
            cursor: disabled ? 'not-allowed' : 'pointer',
          }}
        />
        <div
          style={{
            width: '18px',
            height: '18px',
            borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
            border: `2px solid ${checked || indeterminate ? 'var(--ggui-color-primary-600, #0284c7)' : 'var(--ggui-color-outline, #d4d4d8)'}`,
            backgroundColor: checked || indeterminate ? 'var(--ggui-color-primary-600, #0284c7)' : 'var(--ggui-color-surface, #ffffff)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'all 0.2s',
          }}
        >
          {(checked || indeterminate) && (
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              style={{ color: '#ffffff' }}
            >
              {indeterminate ? (
                <path d="M2.5 6H9.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              ) : (
                <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
              )}
            </svg>
          )}
        </div>
      </div>
      {(label || description) && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {label && (
            <span
              style={{
                fontSize: 'var(--ggui-font-size-sm, 14px)',
                fontWeight: 'var(--ggui-font-weight-medium, 500)' as CSSProperties['fontWeight'],
                color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
              }}
            >
              {label}
            </span>
          )}
          {description && (
            <span
              style={{
                fontSize: 'var(--ggui-font-size-xs, 12px)',
                color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
              }}
            >
              {description}
            </span>
          )}
        </div>
      )}
    </label>
  );
}
