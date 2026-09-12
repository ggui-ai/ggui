import { Fragment } from 'react';
import type { BreadcrumbProps } from './types';
import { Link } from '../primitives/Link';
import { fontSize } from '../tokens/typography';

/**
 * Breadcrumb - A navigation trail showing the current location
 */
export function Breadcrumb({
  items,
  separator = '/',
  onItemClick,
  style,
  className,
}: BreadcrumbProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={className}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        fontSize: fontSize.sm,
        ...style,
      }}
    >
      {items.map((item, index) => {
        const isLast = index === items.length - 1;

        return (
          <Fragment key={index}>
            {index > 0 && (
              <span style={{ color: 'var(--ggui-color-neutral-400, #9ca3af)' }}>{separator}</span>
            )}
            {item.icon && (
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  color: isLast ? 'var(--ggui-color-onContainer, #111827)' : 'var(--ggui-color-neutral-500, #6b7280)',
                }}
              >
                {item.icon}
              </span>
            )}
            {isLast ? (
              <span
                style={{
                  color: 'var(--ggui-color-onContainer, #111827)',
                  fontWeight: 500,
                }}
                aria-current="page"
              >
                {item.label}
              </span>
            ) : item.href ? (
              <Link
                href={item.href}
                tone="muted"
                underline="hover"
                onClick={(e) => {
                  if (onItemClick) {
                    e.preventDefault();
                    onItemClick(item, index);
                  }
                }}
              >
                {item.label}
              </Link>
            ) : (
              <button
                onClick={() => onItemClick?.(item, index)}
                style={{
                  background: 'none',
                  border: 'none',
                  padding: 0,
                  color: 'var(--ggui-color-neutral-500, #6b7280)',
                  cursor: 'pointer',
                  fontSize: 'inherit',
                }}
              >
                {item.label}
              </button>
            )}
          </Fragment>
        );
      })}
    </nav>
  );
}
