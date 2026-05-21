import { useState } from 'react';
import type { SearchFieldProps } from './types';
import { Button } from '../primitives/Button';
import { Spinner } from '../primitives/Spinner';
import { Icon } from '../primitives/Icon';
import { colors } from '../tokens/colors';

/**
 * SearchField - An input with search icon and optional submit button
 */
export function SearchField({
  value: controlledValue,
  onChange,
  onSearch,
  placeholder = 'Search...',
  showButton = false,
  buttonText = 'Search',
  loading,
  disabled,
  size = 'md',
  style,
  className,
}: SearchFieldProps) {
  const [internalValue, setInternalValue] = useState('');
  const value = controlledValue !== undefined ? controlledValue : internalValue;

  const handleChange = (newValue: string) => {
    if (controlledValue === undefined) {
      setInternalValue(newValue);
    }
    onChange?.(newValue);
  };

  const handleSubmit = () => {
    onSearch?.(value);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !disabled) {
      handleSubmit();
    }
  };

  const buttonSizes = {
    sm: 'sm' as const,
    md: 'md' as const,
    lg: 'md' as const,
  };

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        gap: '8px',
        alignItems: 'flex-end',
        ...style,
      }}
    >
      <div style={{ position: 'relative', flex: 1 }}>
        <div
          style={{
            position: 'absolute',
            left: '12px',
            top: '50%',
            transform: 'translateY(-50%)',
            color: colors.gray[400],
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          {loading ? (
            <Spinner size={16} />
          ) : (
            <Icon name="search" size={16} />
          )}
        </div>
        <input
          type="search"
          value={value}
          onChange={(e) => handleChange(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || loading}
          style={{
            width: '100%',
            padding: size === 'sm' ? '6px 10px 6px 36px' : size === 'lg' ? '12px 14px 12px 40px' : '10px 12px 10px 38px',
            paddingLeft: '36px',
            fontSize: size === 'lg' ? '16px' : '14px',
            borderRadius: '6px',
            border: `1px solid ${colors.gray[300]}`,
            backgroundColor: disabled ? colors.gray[50] : colors.white,
            color: colors.gray[900],
            outline: 'none',
            boxSizing: 'border-box',
          }}
        />
      </div>
      {showButton && (
        <Button
          onClick={handleSubmit}
          disabled={disabled || loading}
          size={buttonSizes[size]}
          loading={loading}
        >
          {buttonText}
        </Button>
      )}
    </div>
  );
}
