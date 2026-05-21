import { useId } from 'react';
import type { CSSProperties } from 'react';
import type { SliderProps } from './types';

/**
 * Slider - A range input primitive
 *
 * IMPORTANT: onChange receives the number value directly!
 * Example: onChange={(value) => setValue(value)} or onChange={setValue}
 */
export function Slider({
  label,
  value = 0,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  disabled,
  showValue,
  style,
  className,
}: SliderProps) {
  const uniqueId = useId();
  const sliderId = `${uniqueId}-slider`;
  const labelId = `${uniqueId}-label`;
  const percentage = ((value - min) / (max - min)) * 100;

  return (
    <div className={className} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ggui-spacing-2, 8px)', ...style }}>
      {(label || showValue) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
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
          {showValue && (
            <span
              style={{
                fontSize: 'var(--ggui-font-size-sm, 14px)',
                fontWeight: 'var(--ggui-font-weight-medium, 500)' as CSSProperties['fontWeight'],
                color: 'var(--ggui-color-primary-600, #0284c7)',
              }}
            >
              {value}
            </span>
          )}
        </div>
      )}
      <div style={{ position: 'relative', height: '20px', display: 'flex', alignItems: 'center' }}>
        {/* Track background */}
        <div
          style={{
            position: 'absolute',
            width: '100%',
            height: '6px',
            borderRadius: '3px',
            backgroundColor: 'var(--ggui-color-outlineVariant, #e4e4e7)',
          }}
        />
        {/* Track fill */}
        <div
          style={{
            position: 'absolute',
            width: `${percentage}%`,
            height: '6px',
            borderRadius: '3px',
            backgroundColor: disabled ? 'var(--ggui-color-outline, #d4d4d8)' : 'var(--ggui-color-primary-600, #0284c7)',
            transition: 'width 0.1s',
          }}
        />
        {/* Native input for accessibility */}
        <input
          id={sliderId}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange?.(Number(e.target.value))}
          disabled={disabled}
          aria-labelledby={label ? labelId : undefined}
          aria-label={label ? undefined : 'Slider'}
          aria-valuenow={value}
          aria-valuemin={min}
          aria-valuemax={max}
          style={{
            position: 'absolute',
            width: '100%',
            height: '20px',
            margin: 0,
            opacity: 0,
            cursor: disabled ? 'not-allowed' : 'pointer',
            zIndex: 1,
          }}
        />
        {/* Thumb */}
        <div
          style={{
            position: 'absolute',
            left: `calc(${percentage}% - 10px)`,
            width: '20px',
            height: '20px',
            borderRadius: '50%',
            backgroundColor: '#ffffff',
            border: `2px solid ${disabled ? 'var(--ggui-color-outline, #d4d4d8)' : 'var(--ggui-color-primary-600, #0284c7)'}`,
            boxShadow: 'var(--ggui-shape-shadow-sm, 0 1px 2px rgba(0,0,0,0.05))',
            transition: 'left 0.1s',
            pointerEvents: 'none',
          }}
        />
      </div>
    </div>
  );
}
