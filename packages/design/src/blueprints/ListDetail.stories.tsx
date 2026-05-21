import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ListDetail } from './ListDetail';

const listItems = [
  { id: 1, name: 'Button', category: 'Primitive', description: 'A clickable button element with variants and sizes.' },
  { id: 2, name: 'Input', category: 'Primitive', description: 'A text input field with label and validation support.' },
  { id: 3, name: 'Card', category: 'Primitive', description: 'A container with padding, border, and optional shadow.' },
  { id: 4, name: 'DataTable', category: 'Composition', description: 'A sortable, selectable data table for tabular data.' },
  { id: 5, name: 'ChatWindow', category: 'Composition', description: 'A chat interface with messages and input.' },
];

const mockHeader = React.createElement(
  'div',
  { style: { padding: '12px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
  React.createElement('span', { style: { fontWeight: 700, fontSize: '18px', color: '#0284c7' } }, 'Component Library'),
  React.createElement(
    'div',
    { style: { display: 'flex', gap: '8px' } },
    React.createElement('input', {
      type: 'text',
      placeholder: 'Search components...',
      style: { padding: '6px 12px', border: '1px solid #d1d5db', borderRadius: '6px', fontSize: '13px', outline: 'none', width: '200px' },
    })
  )
);

const mockList = React.createElement(
  'div',
  { style: { padding: '8px' } },
  ...listItems.map((item, i) =>
    React.createElement(
      'div',
      {
        key: item.id,
        style: {
          padding: '12px 16px',
          borderBottom: '1px solid #f3f4f6',
          cursor: 'pointer',
          backgroundColor: i === 0 ? '#f0f9ff' : 'transparent',
        },
      },
      React.createElement(
        'div',
        { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' } },
        React.createElement('span', { style: { fontWeight: 500, fontSize: '14px', color: i === 0 ? '#0284c7' : '#111827' } }, item.name),
        React.createElement('span', { style: { fontSize: '11px', color: '#6b7280', backgroundColor: '#f3f4f6', padding: '2px 6px', borderRadius: '4px' } }, item.category)
      ),
      React.createElement('div', { style: { fontSize: '12px', color: '#6b7280' } }, item.description)
    )
  )
);

const mockDetail = React.createElement(
  'div',
  { style: { padding: '24px' } },
  React.createElement('h2', { style: { fontSize: '20px', fontWeight: 700, marginBottom: '8px', marginTop: 0 } }, 'Button'),
  React.createElement('p', { style: { fontSize: '14px', color: '#6b7280', marginBottom: '24px' } }, 'A clickable button element with variants and sizes.'),
  React.createElement('div', { style: { marginBottom: '24px' } },
    React.createElement('h3', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '12px' } }, 'Preview'),
    React.createElement(
      'div',
      { style: { padding: '24px', border: '1px solid #e5e7eb', borderRadius: '8px', display: 'flex', gap: '8px', backgroundColor: '#fafafa' } },
      React.createElement('button', { style: { padding: '8px 16px', backgroundColor: '#0284c7', color: '#fff', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px' } }, 'Primary'),
      React.createElement('button', { style: { padding: '8px 16px', backgroundColor: '#fff', color: '#374151', border: '1px solid #d1d5db', borderRadius: '6px', cursor: 'pointer', fontSize: '14px' } }, 'Outline'),
      React.createElement('button', { style: { padding: '8px 16px', backgroundColor: '#f3f4f6', color: '#374151', border: 'none', borderRadius: '6px', cursor: 'pointer', fontSize: '14px' } }, 'Ghost')
    )
  ),
  React.createElement('div', null,
    React.createElement('h3', { style: { fontSize: '14px', fontWeight: 600, marginBottom: '12px' } }, 'Props'),
    React.createElement(
      'table',
      { style: { width: '100%', borderCollapse: 'collapse' as const, fontSize: '13px' } },
      React.createElement(
        'thead',
        null,
        React.createElement(
          'tr',
          { style: { borderBottom: '2px solid #e5e7eb' } },
          React.createElement('th', { style: { textAlign: 'left' as const, padding: '8px 0', color: '#6b7280' } }, 'Prop'),
          React.createElement('th', { style: { textAlign: 'left' as const, padding: '8px 0', color: '#6b7280' } }, 'Type'),
          React.createElement('th', { style: { textAlign: 'left' as const, padding: '8px 0', color: '#6b7280' } }, 'Default')
        )
      ),
      React.createElement(
        'tbody',
        null,
        ...([
          ['variant', "'primary' | 'outline' | 'ghost' | 'danger'", "'primary'"],
          ['size', "'sm' | 'md' | 'lg'", "'md'"],
          ['disabled', 'boolean', 'false'],
        ] as const).map(([prop, type, def], i) =>
          React.createElement(
            'tr',
            { key: i, style: { borderBottom: '1px solid #f3f4f6' } },
            React.createElement('td', { style: { padding: '8px 0', fontFamily: 'monospace' } }, prop),
            React.createElement('td', { style: { padding: '8px 0', fontFamily: 'monospace', color: '#6b7280' } }, type),
            React.createElement('td', { style: { padding: '8px 0', fontFamily: 'monospace' } }, def)
          )
        )
      )
    )
  )
);

const meta: Meta<typeof ListDetail> = {
  title: 'Templates/ListDetail',
  component: ListDetail,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) =>
      React.createElement(
        'div',
        { style: { height: '600px' } },
        React.createElement(Story, null)
      ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    header: mockHeader,
    list: mockList,
    detail: mockDetail,
  },
};

export const EmptyDetail: Story = {
  args: {
    header: mockHeader,
    list: mockList,
    emptyDetail: React.createElement(
      'div',
      { style: { display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: '#9ca3af', fontSize: '14px' } },
      'Select a component to view its documentation'
    ),
  },
};

export const WideList: Story = {
  args: {
    header: mockHeader,
    list: mockList,
    detail: mockDetail,
    listWidth: '450px',
  },
};
