import { useState, useId } from 'react';
import type { CSSProperties } from 'react';
import type { AccordionProps } from './types';
import { duration, easing } from '../tokens/transitions';

const chevron = (expanded: boolean) => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 20 20"
    fill="currentColor"
    aria-hidden="true"
    style={{
      transition: `transform ${duration.normal} ${easing.easeInOut}`,
      transform: expanded ? 'rotate(180deg)' : 'rotate(0deg)',
      flexShrink: 0,
    }}
  >
    <path fillRule="evenodd" d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z" clipRule="evenodd" />
  </svg>
);

/**
 * Accordion - Collapsible content sections
 */
export function Accordion({
  items,
  expandedKeys,
  onChange,
  multiple = false,
  variant = 'default',
  style,
  className,
}: AccordionProps) {
  const uniqueId = useId();
  const [internalExpanded, setInternalExpanded] = useState<string[]>([]);
  const currentExpanded = expandedKeys ?? internalExpanded;

  const handleToggle = (key: string) => {
    let newExpanded: string[];

    if (currentExpanded.includes(key)) {
      newExpanded = currentExpanded.filter((k) => k !== key);
    } else if (multiple) {
      newExpanded = [...currentExpanded, key];
    } else {
      newExpanded = [key];
    }

    if (onChange) {
      onChange(newExpanded);
    } else {
      setInternalExpanded(newExpanded);
    }
  };

  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: variant === 'separated' ? 'var(--ggui-spacing-2, 8px)' : '0',
    ...style,
  };

  const getItemStyle = (isFirst: boolean, isLast: boolean): CSSProperties => {
    if (variant === 'separated') {
      return {
        border: '1px solid var(--ggui-color-outlineVariant, #e4e4e7)',
        borderRadius: 'var(--ggui-shape-radius-lg, 8px)',
        overflow: 'hidden',
      };
    }

    if (variant === 'bordered') {
      return {
        borderLeft: '1px solid var(--ggui-color-outlineVariant, #e4e4e7)',
        borderRight: '1px solid var(--ggui-color-outlineVariant, #e4e4e7)',
        borderTop: isFirst ? '1px solid var(--ggui-color-outlineVariant, #e4e4e7)' : undefined,
        borderBottom: '1px solid var(--ggui-color-outlineVariant, #e4e4e7)',
        borderTopLeftRadius: isFirst ? 'var(--ggui-shape-radius-lg, 8px)' : undefined,
        borderTopRightRadius: isFirst ? 'var(--ggui-shape-radius-lg, 8px)' : undefined,
        borderBottomLeftRadius: isLast ? 'var(--ggui-shape-radius-lg, 8px)' : undefined,
        borderBottomRightRadius: isLast ? 'var(--ggui-shape-radius-lg, 8px)' : undefined,
      };
    }

    // default
    return {
      borderBottom: '1px solid var(--ggui-color-outlineVariant, #e4e4e7)',
      borderTop: isFirst ? '1px solid var(--ggui-color-outlineVariant, #e4e4e7)' : undefined,
    };
  };

  return (
    <div className={className} style={containerStyle}>
      {items.map((item, index) => {
        const isExpanded = currentExpanded.includes(item.key);
        const isDisabled = !!item.disabled;
        const isFirst = index === 0;
        const isLast = index === items.length - 1;

        return (
          <div key={item.key} style={getItemStyle(isFirst, isLast)}>
            <h3 style={{ margin: 0 }}>
              <button
                id={`${uniqueId}-header-${item.key}`}
                aria-expanded={isExpanded}
                aria-controls={`${uniqueId}-panel-${item.key}`}
                aria-disabled={isDisabled}
                onClick={isDisabled ? undefined : () => handleToggle(item.key)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  width: '100%',
                  padding: 'var(--ggui-spacing-2, 12px) var(--ggui-spacing-4, 16px)',
                  background: 'none',
                  border: 'none',
                  cursor: isDisabled ? 'not-allowed' : 'pointer',
                  opacity: isDisabled ? 0.5 : 1,
                  fontSize: 'var(--ggui-font-size-sm, 14px)',
                  fontWeight: 'var(--ggui-font-weight-medium, 500)' as CSSProperties['fontWeight'],
                  color: 'var(--ggui-color-onSurface, #18181b)',
                  textAlign: 'left',
                  transition: `background-color ${duration.fast} ${easing.easeInOut}`,
                }}
              >
                <span>{item.title}</span>
                {chevron(isExpanded)}
              </button>
            </h3>
            <div
              id={`${uniqueId}-panel-${item.key}`}
              role="region"
              aria-labelledby={`${uniqueId}-header-${item.key}`}
              hidden={!isExpanded}
              style={{
                overflow: 'hidden',
              }}
            >
              {isExpanded && (
                <div
                  style={{
                    padding: '0 var(--ggui-spacing-4, 16px) var(--ggui-spacing-4, 16px)',
                    fontSize: 'var(--ggui-font-size-sm, 14px)',
                    color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
                    lineHeight: 'var(--ggui-font-lineHeight-normal, 1.5)',
                  }}
                >
                  {item.content}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
