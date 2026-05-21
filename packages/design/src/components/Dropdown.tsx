import { useState, useRef, useEffect } from 'react';
import type { DropdownProps } from './types';
import { MenuItem } from './MenuItem';
import { colors } from '../tokens/colors';
import { radius, shadow, zIndex } from '../tokens/spacing';

/**
 * Dropdown - A menu that appears when clicking a trigger element
 */
export function Dropdown({
  trigger,
  options,
  value,
  onChange,
  placement = 'bottom-start',
  disabled,
  style,
  className,
}: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Close on escape
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscape);
      return () => document.removeEventListener('keydown', handleEscape);
    }
  }, [isOpen]);

  const handleSelect = (optionValue: string) => {
    onChange?.(optionValue);
    setIsOpen(false);
  };

  const getMenuPosition = () => {
    switch (placement) {
      case 'bottom-start':
        return { top: '100%', left: 0, marginTop: '4px' };
      case 'bottom-end':
        return { top: '100%', right: 0, marginTop: '4px' };
      case 'top-start':
        return { bottom: '100%', left: 0, marginBottom: '4px' };
      case 'top-end':
        return { bottom: '100%', right: 0, marginBottom: '4px' };
      default:
        return { top: '100%', left: 0, marginTop: '4px' };
    }
  };

  return (
    <div
      ref={containerRef}
      className={className}
      style={{
        position: 'relative',
        display: 'inline-block',
        ...style,
      }}
    >
      <div
        onClick={() => !disabled && setIsOpen(!isOpen)}
        style={{ cursor: disabled ? 'not-allowed' : 'pointer' }}
      >
        {trigger}
      </div>
      {isOpen && (
        <div
          style={{
            position: 'absolute',
            ...getMenuPosition(),
            minWidth: '160px',
            backgroundColor: colors.white,
            border: `1px solid ${colors.gray[200]}`,
            borderRadius: radius.lg,
            boxShadow: shadow.lg,
            zIndex: zIndex.dropdown,
            padding: '4px',
          }}
        >
          {options.map((option) => (
            <MenuItem
              key={option.value}
              label={option.label}
              icon={option.icon}
              onClick={() => handleSelect(option.value)}
              disabled={option.disabled}
              active={value === option.value}
              danger={option.danger}
            />
          ))}
        </div>
      )}
    </div>
  );
}
