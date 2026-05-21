import { useState, useRef, useEffect, useMemo } from 'react';
import type { AutocompleteProps, AutocompleteOption } from './types';
import { Input } from '../primitives/Input';
import { Spinner } from '../primitives/Spinner';
import { colors } from '../tokens/colors';
import { radius, shadow, zIndex } from '../tokens/spacing';
import { fontSize } from '../tokens/typography';

/**
 * Autocomplete - An input with suggestion dropdown
 */
export function Autocomplete({
  value = '',
  onChange,
  onSelect,
  options,
  placeholder,
  label,
  loading,
  disabled,
  error,
  noResultsText = 'No results found',
  style,
  className,
}: AutocompleteProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [highlightedIndex, setHighlightedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);

  // Filter options based on input value
  const filteredOptions = useMemo(() => {
    if (!value) return options;
    const lowerValue = value.toLowerCase();
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(lowerValue) ||
        opt.value.toLowerCase().includes(lowerValue)
    );
  }, [options, value]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleInputChange = (newValue: string) => {
    onChange?.(newValue);
    setIsOpen(true);
    setHighlightedIndex(-1);
  };

  const handleSelect = (option: AutocompleteOption) => {
    onChange?.(option.label);
    onSelect?.(option);
    setIsOpen(false);
    setHighlightedIndex(-1);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex((prev) =>
          prev < filteredOptions.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex((prev) => (prev > 0 ? prev - 1 : prev));
        break;
      case 'Enter':
        e.preventDefault();
        if (highlightedIndex >= 0 && filteredOptions[highlightedIndex]) {
          handleSelect(filteredOptions[highlightedIndex]);
        }
        break;
      case 'Escape':
        setIsOpen(false);
        setHighlightedIndex(-1);
        break;
    }
  };

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: 'relative',
        ...style,
      }}
    >
      <div onKeyDown={handleKeyDown}>
        <Input
          label={label}
          value={value}
          onChange={handleInputChange}
          onFocus={() => setIsOpen(true)}
          placeholder={placeholder}
          disabled={disabled}
          error={error}
        />
      </div>
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: '4px',
            backgroundColor: colors.white,
            border: `1px solid ${colors.gray[200]}`,
            borderRadius: radius.lg,
            boxShadow: shadow.lg,
            zIndex: zIndex.dropdown,
            maxHeight: '240px',
            overflow: 'auto',
          }}
        >
          {loading ? (
            <div style={{ padding: '12px', display: 'flex', justifyContent: 'center' }}>
              <Spinner size={20} />
            </div>
          ) : filteredOptions.length === 0 ? (
            <div
              style={{
                padding: '12px',
                textAlign: 'center',
                color: colors.gray[500],
                fontSize: fontSize.sm,
              }}
            >
              {noResultsText}
            </div>
          ) : (
            filteredOptions.map((option, index) => (
              <div
                key={option.value}
                onClick={() => !option.disabled && handleSelect(option)}
                style={{
                  padding: '8px 12px',
                  cursor: option.disabled ? 'not-allowed' : 'pointer',
                  backgroundColor:
                    highlightedIndex === index ? colors.gray[100] : 'transparent',
                  color: option.disabled ? colors.gray[400] : colors.gray[900],
                  fontSize: fontSize.sm,
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                }}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                {option.icon && <span style={{ flexShrink: 0 }}>{option.icon}</span>}
                <div style={{ flex: 1 }}>
                  <div>{option.label}</div>
                  {option.description && (
                    <div style={{ fontSize: fontSize.xs, color: colors.gray[500] }}>
                      {option.description}
                    </div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
