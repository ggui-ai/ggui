import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { ToggleProps } from './types';
import { duration, easing } from '../tokens/transitions';

const sizeConfig = {
  sm: { width: 36, height: 20, knob: 16 },
  md: { width: 44, height: 24, knob: 20 },
  lg: { width: 52, height: 28, knob: 24 },
};

/**
 * Toggle - A switch/toggle input primitive
 *
 * IMPORTANT: onChange receives the boolean value directly!
 * Example: onChange={(checked) => setChecked(checked)} or onChange={setChecked}
 */
export function Toggle({
  label,
  checked,
  onChange,
  disabled,
  size = 'md',
  style,
  className,
}: ToggleProps) {
  const config = sizeConfig[size];
  const [focused, setFocused] = useState(false);

  return (
    <label
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--ggui-spacing-2, 8px)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        ...style,
      }}
    >
      <div
        role="switch"
        aria-checked={checked}
        aria-label={label}
        tabIndex={disabled ? -1 : 0}
        onClick={() => !disabled && onChange?.(!checked)}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onChange?.(!checked);
          }
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        style={{
          width: config.width,
          height: config.height,
          borderRadius: '9999px',
          backgroundColor: checked ? 'var(--ggui-color-primary-600, #0284c7)' : 'var(--ggui-color-outline, #d4d4d8)',
          position: 'relative',
          transition: `background-color ${duration.normal} ${easing.easeInOut}, box-shadow ${duration.normal} ${easing.easeInOut}`,
          flexShrink: 0,
          outline: 'none',
          boxShadow: focused
            ? '0 0 0 3px var(--ggui-color-primary-200, #bae6fd)'
            : undefined,
        }}
      >
        <div
          style={{
            width: config.knob,
            height: config.knob,
            borderRadius: '50%',
            backgroundColor: '#ffffff',
            position: 'absolute',
            top: (config.height - config.knob) / 2,
            left: checked ? config.width - config.knob - (config.height - config.knob) / 2 : (config.height - config.knob) / 2,
            transition: `left ${duration.normal} ${easing.easeInOut}`,
            boxShadow: 'var(--ggui-shape-shadow-sm, 0 1px 2px rgba(0,0,0,0.05))',
          }}
        />
      </div>
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
    </label>
  );
}
