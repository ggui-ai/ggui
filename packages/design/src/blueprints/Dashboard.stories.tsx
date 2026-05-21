import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Dashboard } from './Dashboard';

const mockHeader = React.createElement(
  'div',
  { style: { padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
  React.createElement('span', { style: { fontWeight: 700, fontSize: '18px', color: '#0284c7' } }, 'ggui'),
  React.createElement(
    'div',
    { style: { display: 'flex', gap: '12px', alignItems: 'center' } },
    React.createElement(
      'button',
      { style: { padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '6px', backgroundColor: '#fff', fontSize: '13px', cursor: 'pointer' } },
      'Docs'
    ),
    React.createElement('div', { style: { width: '32px', height: '32px', borderRadius: '50%', backgroundColor: '#0284c7', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '13px', fontWeight: 600 } }, 'AC')
  )
);

const mockSidebar = React.createElement(
  'nav',
  { style: { padding: '12px 8px' } },
  ...['Overview', 'Analytics', 'Users', 'Settings'].map((label, i) =>
    React.createElement(
      'div',
      {
        key: i,
        style: {
          padding: '8px 12px',
          borderRadius: '6px',
          fontSize: '14px',
          backgroundColor: i === 0 ? '#f0f9ff' : 'transparent',
          color: i === 0 ? '#0284c7' : '#374151',
          fontWeight: i === 0 ? 500 : 400,
          cursor: 'pointer',
          marginBottom: '2px',
        },
      },
      label
    )
  )
);

function StatCard({ label, value, change }: { label: string; value: string; change: string }) {
  return React.createElement(
    'div',
    {
      style: {
        padding: '20px',
        backgroundColor: '#fff',
        borderRadius: '8px',
        border: '1px solid #e5e7eb',
      },
    },
    React.createElement('div', { style: { fontSize: '13px', color: '#6b7280', marginBottom: '4px' } }, label),
    React.createElement('div', { style: { fontSize: '24px', fontWeight: 700, color: '#111827' } }, value),
    React.createElement('div', { style: { fontSize: '12px', color: '#22c55e', marginTop: '4px' } }, change)
  );
}

const mockStats = React.createElement(
  React.Fragment,
  null,
  React.createElement(StatCard, { label: 'Total Users', value: '12,847', change: '+12.5% this month' }),
  React.createElement(StatCard, { label: 'Active Sessions', value: '1,429', change: '+8.2% this week' }),
  React.createElement(StatCard, { label: 'API Calls', value: '94.2K', change: '+23.1% this month' }),
  React.createElement(StatCard, { label: 'Revenue', value: '$48,290', change: '+15.3% this quarter' })
);

const mockCharts = React.createElement(
  React.Fragment,
  null,
  React.createElement(
    'div',
    { style: { padding: '20px', backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', minHeight: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' } },
    'Usage Chart Placeholder'
  ),
  React.createElement(
    'div',
    { style: { padding: '20px', backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb', minHeight: '200px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#9ca3af' } },
    'Revenue Chart Placeholder'
  )
);

const mockTables = React.createElement(
  'div',
  { style: { padding: '20px', backgroundColor: '#fff', borderRadius: '8px', border: '1px solid #e5e7eb' } },
  React.createElement('div', { style: { fontWeight: 600, marginBottom: '12px', fontSize: '14px' } }, 'Recent Activity'),
  React.createElement(
    'table',
    { style: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' } },
    React.createElement(
      'thead',
      null,
      React.createElement(
        'tr',
        { style: { borderBottom: '1px solid #e5e7eb' } },
        React.createElement('th', { style: { textAlign: 'left' as const, padding: '8px 0', color: '#6b7280', fontWeight: 500 } }, 'User'),
        React.createElement('th', { style: { textAlign: 'left' as const, padding: '8px 0', color: '#6b7280', fontWeight: 500 } }, 'Action'),
        React.createElement('th', { style: { textAlign: 'right' as const, padding: '8px 0', color: '#6b7280', fontWeight: 500 } }, 'Time')
      )
    ),
    React.createElement(
      'tbody',
      null,
      ...['Alice Chen created a project', 'Bob Martinez deployed v2.1', 'Carol Nguyen updated settings'].map((action, i) =>
        React.createElement(
          'tr',
          { key: i, style: { borderBottom: '1px solid #f3f4f6' } },
          React.createElement('td', { style: { padding: '8px 0' } }, action.split(' ')[0] + ' ' + action.split(' ')[1]),
          React.createElement('td', { style: { padding: '8px 0' } }, action.split(' ').slice(2).join(' ')),
          React.createElement('td', { style: { padding: '8px 0', textAlign: 'right' as const, color: '#9ca3af' } }, `${i + 1}h ago`)
        )
      )
    )
  )
);

const meta: Meta<typeof Dashboard> = {
  title: 'Templates/Dashboard',
  component: Dashboard,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) =>
      React.createElement(
        'div',
        { style: { height: '700px' } },
        React.createElement(Story, null)
      ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    header: mockHeader,
    sidebar: mockSidebar,
    stats: mockStats,
    charts: mockCharts,
    tables: mockTables,
  },
};

export const WithoutSidebar: Story = {
  args: {
    header: mockHeader,
    stats: mockStats,
    charts: mockCharts,
    tables: mockTables,
  },
};

export const StatsOnly: Story = {
  args: {
    header: mockHeader,
    sidebar: mockSidebar,
    stats: mockStats,
  },
};
