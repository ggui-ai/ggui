import type { DataTableProps } from './types';
import { Checkbox } from '../primitives/Checkbox';
import { Spinner } from '../primitives/Spinner';
import { Icon } from '../primitives/Icon';
import { colors } from '../tokens/colors';
import { fontSize, fontWeight } from '../tokens/typography';

/**
 * DataTable - A sortable, selectable data table
 */
export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  rowKey = 'id',
  loading,
  emptyText = 'No data',
  onSort,
  sortKey,
  sortDirection,
  onRowClick,
  selectable,
  selectedKeys = [],
  onSelectionChange,
  style,
  className,
}: DataTableProps<T>) {
  const getRowKey = (row: T, index: number): string => {
    if (typeof rowKey === 'function') {
      return rowKey(row);
    }
    return String(row[rowKey] ?? index);
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      onSelectionChange?.(data.map((row, i) => getRowKey(row, i)));
    } else {
      onSelectionChange?.([]);
    }
  };

  const handleSelectRow = (key: string, checked: boolean) => {
    if (checked) {
      onSelectionChange?.([...selectedKeys, key]);
    } else {
      onSelectionChange?.(selectedKeys.filter((k) => k !== key));
    }
  };

  const allSelected = data.length > 0 && selectedKeys.length === data.length;
  const someSelected = selectedKeys.length > 0 && selectedKeys.length < data.length;

  return (
    <div
      className={className}
      style={{
        border: `1px solid ${colors.gray[200]}`,
        borderRadius: '8px',
        overflow: 'hidden',
        ...style,
      }}
    >
      <table
        style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: fontSize.sm,
        }}
      >
        <thead>
          <tr style={{ backgroundColor: colors.gray[50] }}>
            {selectable && (
              <th style={{ width: '40px', padding: '12px' }}>
                <Checkbox
                  checked={allSelected}
                  indeterminate={someSelected}
                  onChange={handleSelectAll}
                />
              </th>
            )}
            {columns.map((col) => (
              <th
                key={col.key}
                style={{
                  padding: '12px 16px',
                  textAlign: col.align || 'left',
                  fontWeight: fontWeight.semibold,
                  color: colors.gray[700],
                  borderBottom: `1px solid ${colors.gray[200]}`,
                  cursor: col.sortable ? 'pointer' : undefined,
                  width: col.width,
                }}
                onClick={() => col.sortable && onSort?.(col.key, sortKey === col.key && sortDirection === 'asc' ? 'desc' : 'asc')}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                  {col.header}
                  {col.sortable && sortKey === col.key && (
                    <Icon
                      name={sortDirection === 'asc' ? 'chevron-up' : 'chevron-down'}
                      size={14}
                    />
                  )}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td
                colSpan={columns.length + (selectable ? 1 : 0)}
                style={{ padding: '48px', textAlign: 'center' }}
              >
                <Spinner size={24} />
              </td>
            </tr>
          ) : data.length === 0 ? (
            <tr>
              <td
                colSpan={columns.length + (selectable ? 1 : 0)}
                style={{ padding: '48px', textAlign: 'center', color: colors.gray[500] }}
              >
                {emptyText}
              </td>
            </tr>
          ) : (
            data.map((row, index) => {
              const key = getRowKey(row, index);
              const isSelected = selectedKeys.includes(key);

              return (
                <tr
                  key={key}
                  onClick={() => onRowClick?.(row, index)}
                  style={{
                    backgroundColor: isSelected ? colors.primary[50] : undefined,
                    cursor: onRowClick ? 'pointer' : undefined,
                    transition: 'background-color 0.15s',
                  }}
                >
                  {selectable && (
                    <td style={{ padding: '12px' }}>
                      <Checkbox
                        checked={isSelected}
                        onChange={(checked) => handleSelectRow(key, checked)}
                      />
                    </td>
                  )}
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      style={{
                        padding: '12px 16px',
                        textAlign: col.align || 'left',
                        color: colors.gray[900],
                        borderBottom: `1px solid ${colors.gray[100]}`,
                      }}
                    >
                      {col.render
                        ? col.render(row[col.key], row, index)
                        : String(row[col.key] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
