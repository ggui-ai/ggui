import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { TableProps, SortDirection } from './types';

const sortIndicator = (active: boolean, direction: SortDirection) => (
  <span
    aria-hidden="true"
    style={{
      display: 'inline-flex',
      flexDirection: 'column',
      marginLeft: '4px',
      fontSize: '10px',
      lineHeight: 1,
      opacity: active ? 1 : 0.3,
    }}
  >
    <span style={{ opacity: active && direction === 'asc' ? 1 : 0.4 }}>&#9650;</span>
    <span style={{ opacity: active && direction === 'desc' ? 1 : 0.4 }}>&#9660;</span>
  </span>
);

/**
 * Table - A data display primitive with sortable columns
 */
export function Table<T extends Record<string, unknown> = Record<string, unknown>>({
  columns,
  data,
  sortKey,
  sortDirection = 'asc',
  onSort,
  striped = false,
  hoverable = true,
  compact = false,
  bordered = false,
  caption,
  style,
  className,
}: TableProps<T>) {
  const [hoveredRow, setHoveredRow] = useState<number | null>(null);

  const cellPadding = compact
    ? 'var(--ggui-spacing-1, 4px) var(--ggui-spacing-2, 8px)'
    : 'var(--ggui-spacing-2, 8px) var(--ggui-spacing-4, 16px)';

  const handleSort = (key: string) => {
    if (!onSort) return;
    const newDirection: SortDirection =
      sortKey === key && sortDirection === 'asc' ? 'desc' : 'asc';
    onSort(key, newDirection);
  };

  const headerStyle: CSSProperties = {
    padding: cellPadding,
    textAlign: 'left',
    fontWeight: 'var(--ggui-font-weight-semibold, 600)' as CSSProperties['fontWeight'],
    fontSize: 'var(--ggui-font-size-xs, 12px)',
    color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    borderBottom: '2px solid var(--ggui-color-outlineVariant, #e4e4e7)',
    whiteSpace: 'nowrap',
    userSelect: 'none',
  };

  return (
    <div
      className={className}
      style={{
        overflowX: 'auto',
        borderRadius: 'var(--ggui-shape-radius-lg, 8px)',
        border: bordered ? '1px solid var(--ggui-color-outlineVariant, #e4e4e7)' : undefined,
        ...style,
      }}
    >
      <table
        role="table"
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 'var(--ggui-font-size-sm, 14px)',
          color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
        }}
      >
        {caption && (
          <caption
            style={{
              padding: cellPadding,
              fontSize: 'var(--ggui-font-size-sm, 14px)',
              color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
              textAlign: 'left',
              captionSide: 'top',
            }}
          >
            {caption}
          </caption>
        )}
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                aria-sort={
                  sortKey === col.key
                    ? sortDirection === 'asc'
                      ? 'ascending'
                      : 'descending'
                    : undefined
                }
                onClick={col.sortable ? () => handleSort(col.key) : undefined}
                onKeyDown={col.sortable ? (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSort(col.key);
                  }
                } : undefined}
                tabIndex={col.sortable ? 0 : undefined}
                style={{
                  ...headerStyle,
                  textAlign: col.align || 'left',
                  width: col.width,
                  cursor: col.sortable ? 'pointer' : 'default',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center' }}>
                  {col.header}
                  {col.sortable && sortIndicator(sortKey === col.key, sortDirection)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, rowIndex) => (
            <tr
              key={rowIndex}
              onMouseEnter={hoverable ? () => setHoveredRow(rowIndex) : undefined}
              onMouseLeave={hoverable ? () => setHoveredRow(null) : undefined}
              style={{
                backgroundColor:
                  hoverable && hoveredRow === rowIndex
                    ? 'var(--ggui-color-surface, #fafafa)'
                    : striped && rowIndex % 2 === 1
                      ? 'var(--ggui-color-surface, #fafafa)'
                      : 'transparent',
                transition: 'background-color 0.15s ease',
              }}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  style={{
                    padding: cellPadding,
                    textAlign: col.align || 'left',
                    borderBottom: '1px solid var(--ggui-color-surfaceVariant, #f4f4f5)',
                    borderRight: bordered
                      ? '1px solid var(--ggui-color-surfaceVariant, #f4f4f5)'
                      : undefined,
                  }}
                >
                  {col.render
                    ? col.render(row[col.key], row, rowIndex)
                    : (row[col.key] as React.ReactNode)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
