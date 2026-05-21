import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { DataTable } from './DataTable';
import type { DataTableColumn } from './types';

type Employee = Record<string, unknown> & {
  id: string;
  name: string;
  role: string;
  department: string;
  salary: number;
  status: string;
};

const sampleColumns: DataTableColumn[] = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'role', header: 'Role', sortable: true },
  { key: 'department', header: 'Department' },
  {
    key: 'salary',
    header: 'Salary',
    align: 'right',
    sortable: true,
    render: (value) => `$${(value as number).toLocaleString()}`,
  },
  { key: 'status', header: 'Status', align: 'center' },
];

const sampleData: Employee[] = [
  { id: '1', name: 'Alice Chen', role: 'Engineer', department: 'Platform', salary: 135000, status: 'Active' },
  { id: '2', name: 'Bob Martinez', role: 'Designer', department: 'Product', salary: 120000, status: 'Active' },
  { id: '3', name: 'Carol Nguyen', role: 'PM', department: 'Product', salary: 140000, status: 'On Leave' },
  { id: '4', name: 'David Kim', role: 'Engineer', department: 'Infrastructure', salary: 145000, status: 'Active' },
  { id: '5', name: 'Eva Johansson', role: 'Data Scientist', department: 'ML', salary: 150000, status: 'Active' },
];

const meta: Meta<typeof DataTable> = {
  title: 'Compositions/DataTable',
  component: DataTable,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    columns: sampleColumns,
    data: sampleData,
    rowKey: 'id',
  },
};

export const Sortable: Story = {
  render: function Render() {
    const [sortKey, setSortKey] = React.useState<string>('name');
    const [sortDirection, setSortDirection] = React.useState<'asc' | 'desc'>('asc');

    const sorted = [...sampleData].sort((a, b) => {
      const aVal = a[sortKey as keyof Employee];
      const bVal = b[sortKey as keyof Employee];
      const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
      return sortDirection === 'asc' ? cmp : -cmp;
    });

    return React.createElement(DataTable, {
      columns: sampleColumns,
      data: sorted,
      rowKey: 'id',
      sortKey,
      sortDirection,
      onSort: (key: string, dir: 'asc' | 'desc') => {
        setSortKey(key);
        setSortDirection(dir);
      },
    });
  },
};

export const Selectable: Story = {
  render: function Render() {
    const [selectedKeys, setSelectedKeys] = React.useState<string[]>([]);

    return React.createElement(DataTable, {
      columns: sampleColumns,
      data: sampleData,
      rowKey: 'id',
      selectable: true,
      selectedKeys,
      onSelectionChange: setSelectedKeys,
    });
  },
};

export const Loading: Story = {
  args: {
    columns: sampleColumns,
    data: [],
    loading: true,
  },
};

export const Empty: Story = {
  args: {
    columns: sampleColumns,
    data: [],
    emptyText: 'No employees found',
  },
};
