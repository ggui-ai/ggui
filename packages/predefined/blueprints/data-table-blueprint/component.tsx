import { useState, useMemo, type ReactNode } from 'react';
import {
  Container,
  Card,
  Row,
  Stack,
  Text,
  Input,
  Button,
  Checkbox,
  Select,
} from '@ggui-ai/design/primitives';

interface Column {
  key: string;
  header: string;
  sortable?: boolean;
  width?: number | string;
  render?: (value: unknown, row: Record<string, unknown>) => ReactNode;
}

type SortDirection = 'asc' | 'desc' | null;

interface DataTableBlueprintProps {
  columns: Column[];
  data: Record<string, unknown>[];
  pageSize?: number;
  selectable?: boolean;
  searchable?: boolean;
  loading?: boolean;
  onRowClick?: (row: Record<string, unknown>) => void;
  onSort?: (key: string, direction: SortDirection) => void;
  onSearch?: (query: string) => void;
  onPageChange?: (page: number) => void;
  onSelectionChange?: (selectedRows: Record<string, unknown>[]) => void;
  onRowAction?: (action: string, row: Record<string, unknown>) => void;
  // Slots
  toolbar?: () => ReactNode;
  emptyState?: () => ReactNode;
  rowActions?: (row: Record<string, unknown>) => ReactNode;
}

export default function DataTableBlueprint({
  columns,
  data,
  pageSize = 10,
  selectable = false,
  searchable = true,
  loading = false,
  onRowClick,
  onSort,
  onSearch,
  onPageChange,
  onSelectionChange,
  _onRowAction,
  toolbar,
  emptyState,
  rowActions,
}: DataTableBlueprintProps) {
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDirection, setSortDirection] = useState<SortDirection>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [currentPageSize, setCurrentPageSize] = useState(pageSize);

  // Filter data based on search
  const filteredData = useMemo(() => {
    if (!searchQuery) return data;
    const query = searchQuery.toLowerCase();
    return data.filter((row) =>
      columns.some((col) => {
        const value = row[col.key];
        return value != null && String(value).toLowerCase().includes(query);
      })
    );
  }, [data, searchQuery, columns]);

  // Sort data
  const sortedData = useMemo(() => {
    if (!sortKey || !sortDirection) return filteredData;
    return [...filteredData].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const comparison = String(aVal).localeCompare(String(bVal));
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [filteredData, sortKey, sortDirection]);

  // Paginate data
  const totalPages = Math.ceil(sortedData.length / currentPageSize);
  const paginatedData = useMemo(() => {
    const start = (currentPage - 1) * currentPageSize;
    return sortedData.slice(start, start + currentPageSize);
  }, [sortedData, currentPage, currentPageSize]);

  const handleSearch = (query: string) => {
    setSearchQuery(query);
    setCurrentPage(1);
    onSearch?.(query);
  };

  const handleSort = (key: string) => {
    const column = columns.find((c) => c.key === key);
    if (!column?.sortable) return;

    let newDirection: SortDirection = 'asc';
    if (sortKey === key) {
      newDirection = sortDirection === 'asc' ? 'desc' : sortDirection === 'desc' ? null : 'asc';
    }

    setSortKey(newDirection ? key : null);
    setSortDirection(newDirection);
    onSort?.(key, newDirection);
  };

  const handlePageChange = (page: number) => {
    setCurrentPage(page);
    onPageChange?.(page);
  };

  const handleSelectAll = (checked: boolean) => {
    if (checked) {
      const allIds = new Set(paginatedData.map((row) => String(row.id || row._id || '')));
      setSelectedIds(allIds);
      onSelectionChange?.(paginatedData);
    } else {
      setSelectedIds(new Set());
      onSelectionChange?.([]);
    }
  };

  const handleSelectRow = (row: Record<string, unknown>, checked: boolean) => {
    const rowId = String(row.id || row._id || '');
    const newSelected = new Set(selectedIds);
    if (checked) {
      newSelected.add(rowId);
    } else {
      newSelected.delete(rowId);
    }
    setSelectedIds(newSelected);
    onSelectionChange?.(data.filter((r) => newSelected.has(String(r.id || r._id || ''))));
  };

  const isAllSelected = paginatedData.length > 0 && paginatedData.every((row) =>
    selectedIds.has(String(row.id || row._id || ''))
  );

  const getSortIcon = (key: string) => {
    if (sortKey !== key) return '↕';
    return sortDirection === 'asc' ? '↑' : sortDirection === 'desc' ? '↓' : '↕';
  };

  const defaultEmptyState = () => (
    <div style={{ padding: 48, textAlign: 'center' }}>
      <div style={{ fontSize: 48, marginBottom: 16 }}>📋</div>
      <Text variant="body" style={{ color: '#6b7280' }}>
        No data available
      </Text>
    </div>
  );

  return (
    <Container style={{ padding: 24 }}>
      <Card padding="none">
        {/* Toolbar */}
        <div style={{ padding: 16, borderBottom: '1px solid #e5e7eb' }}>
          {toolbar ? (
            toolbar()
          ) : (
            <Row justify="between" align="center" gap="md">
              <Row gap="md" align="center">
                {searchable && (
                  <Input
                    type="search"
                    placeholder="Search..."
                    value={searchQuery}
                    onChange={handleSearch}
                    aria-label="Search table"
                    style={{ width: 240 }}
                  />
                )}
                {selectedIds.size > 0 && (
                  <Text variant="small" style={{ color: '#6b7280' }}>
                    {selectedIds.size} selected
                  </Text>
                )}
              </Row>
              <Row gap="sm" align="center">
                <Text variant="small" style={{ color: '#6b7280' }}>
                  Show:
                </Text>
                <Select
                  value={String(currentPageSize)}
                  options={[
                    { value: '10', label: '10' },
                    { value: '25', label: '25' },
                    { value: '50', label: '50' },
                    { value: '100', label: '100' },
                  ]}
                  onChange={(value) => {
                    setCurrentPageSize(Number(value));
                    setCurrentPage(1);
                  }}
                  aria-label="Rows per page"
                />
              </Row>
            </Row>
          )}
        </div>

        {/* Table */}
        <div style={{ overflowX: 'auto' }}>
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
              fontSize: 14,
            }}
          >
            <thead>
              <tr style={{ backgroundColor: '#f9fafb' }}>
                {selectable && (
                  <th style={{ width: 40, padding: '12px 16px', textAlign: 'left' }}>
                    <Checkbox
                      checked={isAllSelected}
                      onChange={handleSelectAll}
                      aria-label="Select all rows"
                    />
                  </th>
                )}
                {columns.map((column) => (
                  <th
                    key={column.key}
                    onClick={() => handleSort(column.key)}
                    style={{
                      padding: '12px 16px',
                      textAlign: 'left',
                      fontWeight: 600,
                      color: '#374151',
                      borderBottom: '1px solid #e5e7eb',
                      cursor: column.sortable ? 'pointer' : 'default',
                      width: column.width,
                      userSelect: 'none',
                    }}
                  >
                    <Row gap="xs" align="center">
                      {column.header}
                      {column.sortable && (
                        <span style={{ color: '#9ca3af', fontSize: 12 }}>
                          {getSortIcon(column.key)}
                        </span>
                      )}
                    </Row>
                  </th>
                ))}
                {rowActions && (
                  <th style={{ width: 100, padding: '12px 16px', textAlign: 'right' }}>
                    Actions
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td
                    colSpan={columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0)}
                    style={{ padding: 48, textAlign: 'center' }}
                  >
                    <Text variant="body" style={{ color: '#6b7280' }}>
                      Loading...
                    </Text>
                  </td>
                </tr>
              ) : paginatedData.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0)}>
                    {emptyState ? emptyState() : defaultEmptyState()}
                  </td>
                </tr>
              ) : (
                paginatedData.map((row, rowIndex) => {
                  const rowId = String(row.id || row._id || rowIndex);
                  const isSelected = selectedIds.has(rowId);
                  return (
                    <tr
                      key={rowId}
                      onClick={() => onRowClick?.(row)}
                      style={{
                        backgroundColor: isSelected
                          ? '#eef2ff'
                          : rowIndex % 2 === 0
                            ? '#ffffff'
                            : '#f9fafb',
                        cursor: onRowClick ? 'pointer' : 'default',
                      }}
                    >
                      {selectable && (
                        <td
                          style={{ padding: '12px 16px' }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <Checkbox
                            checked={isSelected}
                            onChange={(checked) => handleSelectRow(row, checked)}
                            aria-label={`Select row ${rowIndex + 1}`}
                          />
                        </td>
                      )}
                      {columns.map((column) => (
                        <td
                          key={column.key}
                          style={{
                            padding: '12px 16px',
                            borderBottom: '1px solid #e5e7eb',
                            color: '#374151',
                          }}
                        >
                          {column.render
                            ? column.render(row[column.key], row)
                            : String(row[column.key] ?? '')}
                        </td>
                      ))}
                      {rowActions && (
                        <td
                          style={{
                            padding: '12px 16px',
                            borderBottom: '1px solid #e5e7eb',
                            textAlign: 'right',
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {rowActions(row)}
                        </td>
                      )}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div
            style={{
              padding: 16,
              borderTop: '1px solid #e5e7eb',
              backgroundColor: '#f9fafb',
            }}
          >
            <Row justify="between" align="center">
              <Text variant="small" style={{ color: '#6b7280' }}>
                Showing {(currentPage - 1) * currentPageSize + 1} to{' '}
                {Math.min(currentPage * currentPageSize, sortedData.length)} of{' '}
                {sortedData.length} results
              </Text>
              <Row gap="xs">
                <Button
                  variant="secondary"
                  onPress={() => handlePageChange(currentPage - 1)}
                  disabled={currentPage === 1}
                  aria-label="Previous page"
                >
                  ←
                </Button>
                {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                  let pageNum: number;
                  if (totalPages <= 5) {
                    pageNum = i + 1;
                  } else if (currentPage <= 3) {
                    pageNum = i + 1;
                  } else if (currentPage >= totalPages - 2) {
                    pageNum = totalPages - 4 + i;
                  } else {
                    pageNum = currentPage - 2 + i;
                  }
                  return (
                    <Button
                      key={pageNum}
                      variant={currentPage === pageNum ? 'primary' : 'secondary'}
                      onPress={() => handlePageChange(pageNum)}
                      aria-label={`Page ${pageNum}`}
                      aria-current={currentPage === pageNum ? 'page' : undefined}
                    >
                      {pageNum}
                    </Button>
                  );
                })}
                <Button
                  variant="secondary"
                  onPress={() => handlePageChange(currentPage + 1)}
                  disabled={currentPage === totalPages}
                  aria-label="Next page"
                >
                  →
                </Button>
              </Row>
            </Row>
          </div>
        )}
      </Card>
    </Container>
  );
}
