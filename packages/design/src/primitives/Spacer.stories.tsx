import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Spacer } from './Spacer';

const colorBlock = (label: string, color = '#0284c7') =>
  React.createElement(
    'div',
    {
      style: {
        padding: '12px 20px',
        backgroundColor: color,
        color: '#ffffff',
        borderRadius: '6px',
        fontWeight: 500,
        fontSize: '14px',
        flexShrink: 0,
      },
    },
    label
  );

const meta: Meta<typeof Spacer> = {
  title: 'Primitives/Layout/Spacer',
  component: Spacer,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'text',
      description: 'Fixed size in pixels, or "flex" to fill available space',
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    size: 16,
  },
  decorators: [
    (Story) =>
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center' } },
        colorBlock('Before'),
        React.createElement(Story),
        colorBlock('After')
      ),
  ],
};

export const Small: Story = {
  args: {
    size: 8,
  },
  decorators: [
    (Story) =>
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center' } },
        colorBlock('Before'),
        React.createElement(Story),
        colorBlock('After')
      ),
  ],
};

export const Large: Story = {
  args: {
    size: 48,
  },
  decorators: [
    (Story) =>
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center' } },
        colorBlock('Before'),
        React.createElement(Story),
        colorBlock('After')
      ),
  ],
};

export const Flex: Story = {
  args: {
    size: 'flex' as const,
  },
  decorators: [
    (Story) =>
      React.createElement(
        'div',
        { style: { display: 'flex', alignItems: 'center', width: '400px' } },
        colorBlock('Left'),
        React.createElement(Story),
        colorBlock('Right')
      ),
  ],
};

export const AllVariants: Story = {
  render: () =>
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '24px', width: '400px' } },
      React.createElement(
        'div',
        null,
        React.createElement('p', { style: { marginBottom: '8px', fontWeight: 600 } }, 'size: 8'),
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center' } },
          colorBlock('A'),
          React.createElement(Spacer, { size: 8 }),
          colorBlock('B')
        )
      ),
      React.createElement(
        'div',
        null,
        React.createElement('p', { style: { marginBottom: '8px', fontWeight: 600 } }, 'size: 16 (default)'),
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center' } },
          colorBlock('A'),
          React.createElement(Spacer, { size: 16 }),
          colorBlock('B')
        )
      ),
      React.createElement(
        'div',
        null,
        React.createElement('p', { style: { marginBottom: '8px', fontWeight: 600 } }, 'size: 32'),
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center' } },
          colorBlock('A'),
          React.createElement(Spacer, { size: 32 }),
          colorBlock('B')
        )
      ),
      React.createElement(
        'div',
        null,
        React.createElement('p', { style: { marginBottom: '8px', fontWeight: 600 } }, 'size: "flex" (fills space)'),
        React.createElement(
          'div',
          { style: { display: 'flex', alignItems: 'center' } },
          colorBlock('Left'),
          React.createElement(Spacer, { size: 'flex' }),
          colorBlock('Right')
        )
      )
    ),
};
