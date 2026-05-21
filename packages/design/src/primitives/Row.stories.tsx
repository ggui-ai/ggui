import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Row } from './Row';
import type { RowProps } from './types';

const sampleBox = (label: string, color = '#0284c7') =>
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
      },
    },
    label
  );

// Typed against `RowProps` (own props), not `typeof Row`: `Row`'s
// public type is `WithTrait<RowProps>` — a discriminated union on
// `as` — which Storybook's `StoryObj` arg inference collapses to
// `never`.
const meta: Meta<RowProps> = {
  title: 'Primitives/Layout/Row',
  component: Row,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    gap: { control: 'number' },
    align: {
      control: 'select',
      options: ['start', 'center', 'end', 'stretch'],
    },
    justify: {
      control: 'select',
      options: ['start', 'center', 'end', 'between', 'around', 'evenly'],
    },
    wrap: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    gap: 8,
    children: [sampleBox('Item 1'), sampleBox('Item 2'), sampleBox('Item 3')],
  },
};

export const LargeGap: Story = {
  args: {
    gap: 24,
    children: [sampleBox('Item 1'), sampleBox('Item 2'), sampleBox('Item 3')],
  },
};

export const CenterAligned: Story = {
  args: {
    gap: 8,
    align: 'center',
    children: [
      sampleBox('Short'),
      React.createElement(
        'div',
        { style: { padding: '24px 20px', backgroundColor: '#0284c7', color: '#fff', borderRadius: '6px' } },
        'Tall'
      ),
      sampleBox('Short'),
    ],
  },
};

export const SpaceBetween: Story = {
  args: {
    gap: 8,
    justify: 'between',
    children: [sampleBox('Left'), sampleBox('Center'), sampleBox('Right')],
  },
};

export const Wrapped: Story = {
  args: {
    gap: 8,
    wrap: true,
    children: Array.from({ length: 8 }, (_, i) => sampleBox(`Item ${i + 1}`)),
  },
  parameters: {
    layout: 'padded',
  },
};

export const AllVariants: Story = {
  render: () =>
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '24px' } },
      React.createElement(
        'div',
        null,
        React.createElement('p', { style: { marginBottom: '8px', fontWeight: 600 } }, 'Default (gap: 8)'),
        React.createElement(Row, { gap: 8 }, sampleBox('A'), sampleBox('B'), sampleBox('C'))
      ),
      React.createElement(
        'div',
        null,
        React.createElement('p', { style: { marginBottom: '8px', fontWeight: 600 } }, 'Justify: space-between'),
        React.createElement(
          Row,
          { gap: 8, justify: 'between' },
          sampleBox('Left'),
          sampleBox('Right')
        )
      ),
      React.createElement(
        'div',
        null,
        React.createElement('p', { style: { marginBottom: '8px', fontWeight: 600 } }, 'Align: center'),
        React.createElement(
          Row,
          { gap: 8, align: 'center' },
          sampleBox('Normal'),
          React.createElement(
            'div',
            { style: { padding: '24px 20px', backgroundColor: '#0284c7', color: '#fff', borderRadius: '6px' } },
            'Tall'
          ),
          sampleBox('Normal')
        )
      ),
      React.createElement(
        'div',
        null,
        React.createElement('p', { style: { marginBottom: '8px', fontWeight: 600 } }, 'Wrap: true'),
        React.createElement(
          Row,
          { gap: 8, wrap: true },
          ...Array.from({ length: 6 }, (_, i) => sampleBox(`Item ${i + 1}`))
        )
      )
    ),
};
