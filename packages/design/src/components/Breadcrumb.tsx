import { Fragment } from 'react';
import type { BreadcrumbProps } from './types';
import { Link } from '../primitives/Link';
import { colors } from '../tokens/colors';
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
              <span style={{ color: colors.gray[400] }}>{separator}</span>
            )}
            {item.icon && (
              <span
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  color: isLast ? colors.gray[900] : colors.gray[500],
                }}
              >
                {item.icon}
              </span>
            )}
            {isLast ? (
              <span
                style={{
                  color: colors.gray[900],
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
                  color: colors.gray[500],
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
