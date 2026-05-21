import { useState, useId, useRef, useCallback } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';
import type { TabsProps } from './types';
import { duration, easing } from '../tokens/transitions';

const sizeStyles: Record<string, CSSProperties> = {
  sm: {
    padding: 'var(--ggui-spacing-1, 4px) var(--ggui-spacing-2, 8px)',
    fontSize: 'var(--ggui-font-size-xs, 12px)',
  },
  md: {
    padding: 'var(--ggui-spacing-2, 8px) var(--ggui-spacing-4, 16px)',
    fontSize: 'var(--ggui-font-size-sm, 14px)',
  },
  lg: {
    padding: 'var(--ggui-spacing-4, 12px) var(--ggui-spacing-6, 24px)',
    fontSize: 'var(--ggui-font-size-base, 16px)',
  },
};

/**
 * Tabs - A tab navigation primitive with accessible panels
 */
export function Tabs({
  items,
  activeKey,
  onChange,
  variant = 'line',
  size = 'md',
  fullWidth = false,
  style,
  className,
}: TabsProps) {
  const uniqueId = useId();
  const [internalKey, setInternalKey] = useState(items[0]?.key);
  const currentKey = activeKey ?? internalKey;

  const handleChange = useCallback((key: string) => {
    if (onChange) {
      onChange(key);
    } else {
      setInternalKey(key);
    }
  }, [onChange]);

  const activeItem = items.find((item) => item.key === currentKey);
  const tabListRef = useRef<HTMLDivElement>(null);

  const handleTabKeyDown = useCallback((e: KeyboardEvent<HTMLButtonElement>) => {
    const enabledItems = items.filter((item) => !item.disabled);
    const currentIndex = enabledItems.findIndex((item) => item.key === currentKey);

    let nextIndex: number | undefined;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextIndex = (currentIndex + 1) % enabledItems.length;
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      nextIndex = (currentIndex - 1 + enabledItems.length) % enabledItems.length;
    } else if (e.key === 'Home') {
      e.preventDefault();
      nextIndex = 0;
    } else if (e.key === 'End') {
      e.preventDefault();
      nextIndex = enabledItems.length - 1;
    }

    if (nextIndex !== undefined) {
      const nextItem = enabledItems[nextIndex];
      handleChange(nextItem.key);
      const nextTab = tabListRef.current?.querySelector<HTMLButtonElement>(
        `#${CSS.escape(`${uniqueId}-tab-${nextItem.key}`)}`
      );
      nextTab?.focus();
    }
  }, [items, currentKey, uniqueId, handleChange]);

  const getTabStyle = (isActive: boolean, isDisabled: boolean): CSSProperties => {
    const base: CSSProperties = {
      ...sizeStyles[size],
      display: 'inline-flex',
      alignItems: 'center',
      gap: 'var(--ggui-spacing-1, 4px)',
      cursor: isDisabled ? 'not-allowed' : 'pointer',
      opacity: isDisabled ? 0.5 : 1,
      background: 'none',
      border: 'none',
      fontWeight: isActive
        ? ('var(--ggui-font-weight-semibold, 600)' as CSSProperties['fontWeight'])
        : ('var(--ggui-font-weight-medium, 500)' as CSSProperties['fontWeight']),
      transition: `color ${duration.normal} ${easing.easeInOut}, background-color ${duration.normal} ${easing.easeInOut}, border-color ${duration.normal} ${easing.easeInOut}`,
      whiteSpace: 'nowrap',
      flex: fullWidth ? 1 : undefined,
      justifyContent: fullWidth ? 'center' : undefined,
    };

    if (variant === 'line') {
      return {
        ...base,
        color: isActive
          ? 'var(--ggui-color-primary-600, #0284c7)'
          : 'var(--ggui-color-onSurfaceVariant, #52525b)',
        borderBottom: isActive
          ? '2px solid var(--ggui-color-primary-600, #0284c7)'
          : '2px solid transparent',
        marginBottom: '-1px',
      };
    }

    if (variant === 'pills') {
      return {
        ...base,
        color: isActive ? '#ffffff' : 'var(--ggui-color-onSurfaceVariant, #52525b)',
        backgroundColor: isActive
          ? 'var(--ggui-color-primary-600, #0284c7)'
          : 'transparent',
        borderRadius: 'var(--ggui-shape-radius-md, 6px)',
      };
    }

    // enclosed
    return {
      ...base,
      color: isActive
        ? 'var(--ggui-color-primary-600, #0284c7)'
        : 'var(--ggui-color-onSurfaceVariant, #52525b)',
      backgroundColor: isActive
        ? 'var(--ggui-color-surface, #ffffff)'
        : 'transparent',
      border: isActive
        ? '1px solid var(--ggui-color-outlineVariant, #e4e4e7)'
        : '1px solid transparent',
      borderBottom: isActive ? '1px solid var(--ggui-color-surface, #ffffff)' : '1px solid transparent',
      borderRadius: 'var(--ggui-shape-radius-md, 6px) var(--ggui-shape-radius-md, 6px) 0 0',
      marginBottom: '-1px',
    };
  };

  const tabListStyle: CSSProperties = {
    display: 'flex',
    gap: variant === 'pills' ? 'var(--ggui-spacing-1, 4px)' : '0',
    borderBottom:
      variant === 'line' || variant === 'enclosed'
        ? '1px solid var(--ggui-color-outlineVariant, #e4e4e7)'
        : undefined,
    backgroundColor:
      variant === 'pills'
        ? 'var(--ggui-color-surfaceVariant, #f4f4f5)'
        : undefined,
    borderRadius:
      variant === 'pills'
        ? 'var(--ggui-shape-radius-lg, 8px)'
        : undefined,
    padding:
      variant === 'pills'
        ? 'var(--ggui-spacing-1, 4px)'
        : undefined,
  };

  return (
    <div className={className} style={style}>
      <div ref={tabListRef} role="tablist" aria-orientation="horizontal" style={tabListStyle}>
        {items.map((item) => {
          const isActive = item.key === currentKey;
          const isDisabled = !!item.disabled;
          return (
            <button
              key={item.key}
              role="tab"
              id={`${uniqueId}-tab-${item.key}`}
              aria-selected={isActive}
              aria-controls={`${uniqueId}-panel-${item.key}`}
              aria-disabled={isDisabled}
              tabIndex={isActive ? 0 : -1}
              onClick={isDisabled ? undefined : () => handleChange(item.key)}
              onKeyDown={isDisabled ? undefined : handleTabKeyDown}
              style={getTabStyle(isActive, isDisabled)}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </div>
      {activeItem && (
        <div
          role="tabpanel"
          id={`${uniqueId}-panel-${activeItem.key}`}
          aria-labelledby={`${uniqueId}-tab-${activeItem.key}`}
          tabIndex={0}
          style={{
            padding: 'var(--ggui-spacing-4, 16px) 0',
          }}
        >
          {activeItem.content}
        </div>
      )}
    </div>
  );
}
