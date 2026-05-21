import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Spinner } from './Spinner';

const meta: Meta<typeof Spinner> = {
  title: 'Primitives/Feedback/Spinner',
  component: Spinner,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    size: { control: { type: 'number', min: 12, max: 64, step: 4 } },
    tone: {
      control: 'select',
      options: [
        undefined,
        'default',
        'muted',
        'subtle',
        'emphasized',
        'loud',
        'success',
        'warning',
        'error',
        'info',
        'inverse',
        'inherit',
      ],
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {},
};

export const Small: Story = {
  args: {
    size: 16,
  },
};

export const Large: Story = {
  args: {
    size: 48,
  },
};

export const CustomColor: Story = {
  args: {
    tone: 'error',
  },
};

export const AllVariants: Story = {
  render: () =>
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '24px', alignItems: 'center' } },
      React.createElement(
        'div',
        { style: { display: 'flex', gap: '16px', alignItems: 'center' } },
        React.createElement(Spinner, { size: 16 }),
        React.createElement(Spinner, { size: 24 }),
        React.createElement(Spinner, { size: 32 }),
        React.createElement(Spinner, { size: 48 })
      ),
      React.createElement(
        'div',
        { style: { display: 'flex', gap: '16px', alignItems: 'center' } },
        React.createElement(Spinner, { tone: 'info' }),
        React.createElement(Spinner, { tone: 'success' }),
        React.createElement(Spinner, { tone: 'error' }),
        React.createElement(Spinner, { tone: 'emphasized' })
      )
    ),
};
