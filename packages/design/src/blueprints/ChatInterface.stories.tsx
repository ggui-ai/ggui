import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ChatInterface } from './ChatInterface';

const mockMessages = React.createElement(
  'div',
  { style: { padding: '16px', display: 'flex', flexDirection: 'column' as const, gap: '12px' } },
  React.createElement(
    'div',
    { style: { display: 'flex', gap: '8px', alignItems: 'flex-end' } },
    React.createElement('div', {
      style: { width: '32px', height: '32px', borderRadius: '50%', backgroundColor: '#e5e7eb', flexShrink: 0 },
    }),
    React.createElement(
      'div',
      { style: { padding: '10px 14px', borderRadius: '12px', backgroundColor: '#f3f4f6', maxWidth: '70%', fontSize: '14px' } },
      'Hello! How can I help you today?'
    )
  ),
  React.createElement(
    'div',
    { style: { display: 'flex', gap: '8px', alignItems: 'flex-end', flexDirection: 'row-reverse' as const } },
    React.createElement(
      'div',
      { style: { padding: '10px 14px', borderRadius: '12px', backgroundColor: '#0284c7', color: '#fff', maxWidth: '70%', fontSize: '14px' } },
      'I need help with setting up the design tokens.'
    )
  ),
  React.createElement(
    'div',
    { style: { display: 'flex', gap: '8px', alignItems: 'flex-end' } },
    React.createElement('div', {
      style: { width: '32px', height: '32px', borderRadius: '50%', backgroundColor: '#e5e7eb', flexShrink: 0 },
    }),
    React.createElement(
      'div',
      { style: { padding: '10px 14px', borderRadius: '12px', backgroundColor: '#f3f4f6', maxWidth: '70%', fontSize: '14px' } },
      'Sure! Design tokens are defined in packages/design/src/tokens/. You can add colors, spacing, and typography values there.'
    )
  )
);

const mockInput = React.createElement(
  'div',
  { style: { display: 'flex', gap: '8px' } },
  React.createElement('input', {
    type: 'text',
    placeholder: 'Type a message...',
    style: {
      flex: 1,
      padding: '10px 14px',
      border: '1px solid #d1d5db',
      borderRadius: '9999px',
      fontSize: '14px',
      outline: 'none',
    },
  }),
  React.createElement(
    'button',
    {
      style: {
        padding: '10px 16px',
        backgroundColor: '#0284c7',
        color: '#fff',
        border: 'none',
        borderRadius: '8px',
        cursor: 'pointer',
        fontSize: '14px',
      },
    },
    'Send'
  )
);

const mockHeader = React.createElement(
  'div',
  { style: { padding: '12px 16px', display: 'flex', alignItems: 'center', gap: '12px' } },
  React.createElement('div', {
    style: { width: '36px', height: '36px', borderRadius: '50%', backgroundColor: '#e5e7eb' },
  }),
  React.createElement(
    'div',
    null,
    React.createElement('div', { style: { fontWeight: 600, fontSize: '14px' } }, 'AI Assistant'),
    React.createElement('div', { style: { fontSize: '12px', color: '#6b7280' } }, 'Online')
  )
);

const mockSidebar = React.createElement(
  'div',
  { style: { padding: '12px' } },
  React.createElement('div', { style: { fontWeight: 600, fontSize: '12px', color: '#6b7280', textTransform: 'uppercase' as const, marginBottom: '8px', padding: '4px 8px' } }, 'Conversations'),
  ...[
    { label: 'Design Tokens', active: true },
    { label: 'Component API', active: false },
    { label: 'Theme Setup', active: false },
  ].map((item, i) =>
    React.createElement(
      'div',
      {
        key: i,
        style: {
          padding: '8px 12px',
          borderRadius: '6px',
          fontSize: '14px',
          backgroundColor: item.active ? '#eff6ff' : 'transparent',
          color: item.active ? '#0284c7' : '#374151',
          cursor: 'pointer',
          marginBottom: '2px',
        },
      },
      item.label
    )
  )
);

const meta: Meta<typeof ChatInterface> = {
  title: 'Templates/ChatInterface',
  component: ChatInterface,
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
    messages: mockMessages,
    input: mockInput,
    sidebar: mockSidebar,
    sidebarPosition: 'left',
  },
};

export const NoSidebar: Story = {
  args: {
    header: mockHeader,
    messages: mockMessages,
    input: mockInput,
  },
};

export const RightSidebar: Story = {
  args: {
    header: mockHeader,
    messages: mockMessages,
    input: mockInput,
    sidebar: mockSidebar,
    sidebarPosition: 'right',
  },
};
