import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Table } from './Table';
import type { SortDirection } from './types';
import { Badge } from './Badge';

const meta: Meta<typeof Table> = {
  title: 'Primitives/Data Display/Table',
  component: Table,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    striped: { control: 'boolean' },
    hoverable: { control: 'boolean' },
    compact: { control: 'boolean' },
    bordered: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const sampleData = [
  { name: 'Alice Johnson', email: 'alice@example.com', role: 'Admin', status: 'Active' },
  { name: 'Bob Smith', email: 'bob@example.com', role: 'Editor', status: 'Active' },
  { name: 'Carol White', email: 'carol@example.com', role: 'Viewer', status: 'Inactive' },
  { name: 'David Brown', email: 'david@example.com', role: 'Editor', status: 'Active' },
  { name: 'Eve Davis', email: 'eve@example.com', role: 'Admin', status: 'Pending' },
];

const columns = [
  { key: 'name', header: 'Name', sortable: true },
  { key: 'email', header: 'Email', sortable: true },
  { key: 'role', header: 'Role' },
  { key: 'status', header: 'Status' },
];

export const Default: Story = {
  args: {
    columns,
    data: sampleData,
  },
};

export const Striped: Story = {
  args: {
    columns,
    data: sampleData,
    striped: true,
  },
};

export const Bordered: Story = {
  args: {
    columns,
    data: sampleData,
    bordered: true,
  },
};

export const Compact: Story = {
  args: {
    columns,
    data: sampleData,
    compact: true,
  },
};

export const WithCaption: Story = {
  args: {
    columns,
    data: sampleData,
    caption: 'Team members and their roles',
  },
};

export const Sortable: Story = {
  render: () => {
    const [sortKey, setSortKey] = useState<string | undefined>();
    const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

    const sortedData = [...sampleData].sort((a, b) => {
      if (!sortKey) return 0;
      const aVal = a[sortKey as keyof typeof a];
      const bVal = b[sortKey as keyof typeof b];
      const cmp = String(aVal).localeCompare(String(bVal));
      return sortDirection === 'asc' ? cmp : -cmp;
    });

    return (
      <Table
        columns={columns}
        data={sortedData}
        sortKey={sortKey}
        sortDirection={sortDirection}
        onSort={(key, dir) => {
          setSortKey(key);
          setSortDirection(dir);
        }}
      />
    );
  },
};

export const CustomRenderers: Story = {
  render: () => (
    <Table
      columns={[
        { key: 'name', header: 'Name', sortable: true },
        { key: 'email', header: 'Email' },
        {
          key: 'status',
          header: 'Status',
          render: (value) => {
            const variant = value === 'Active' ? 'success' : value === 'Pending' ? 'warning' : 'default';
            return <Badge variant={variant} size="sm">{String(value)}</Badge>;
          },
        },
      ]}
      data={sampleData}
    />
  ),
};
