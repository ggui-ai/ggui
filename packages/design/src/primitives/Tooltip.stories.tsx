import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Tooltip } from './Tooltip';
import { Button } from './Button';

const meta: Meta<typeof Tooltip> = {
  title: 'Primitives/Interactive/Tooltip',
  component: Tooltip,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    content: { control: 'text' },
    position: {
      control: 'select',
      options: ['top', 'bottom', 'left', 'right'],
    },
    delay: { control: { type: 'number', min: 0, max: 1000, step: 50 } },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    content: 'This is a tooltip',
    children: React.createElement(Button, { variant: 'outline' }, 'Hover me'),
  },
};

export const Top: Story = {
  args: {
    content: 'Tooltip on top',
    position: 'top',
    children: React.createElement(Button, { variant: 'outline' }, 'Top'),
  },
};

export const Bottom: Story = {
  args: {
    content: 'Tooltip on bottom',
    position: 'bottom',
    children: React.createElement(Button, { variant: 'outline' }, 'Bottom'),
  },
};

export const Left: Story = {
  args: {
    content: 'Tooltip on left',
    position: 'left',
    children: React.createElement(Button, { variant: 'outline' }, 'Left'),
  },
};

export const Right: Story = {
  args: {
    content: 'Tooltip on right',
    position: 'right',
    children: React.createElement(Button, { variant: 'outline' }, 'Right'),
  },
};

export const NoDelay: Story = {
  args: {
    content: 'Instant tooltip',
    delay: 0,
    children: React.createElement(Button, { variant: 'outline' }, 'No Delay'),
  },
};

export const AllVariants: Story = {
  render: () =>
    React.createElement(
      'div',
      {
        style: {
          display: 'flex',
          gap: '24px',
          alignItems: 'center',
          padding: '60px',
        },
      },
      React.createElement(
        Tooltip,
        { content: 'Top tooltip', position: 'top', children: React.createElement(Button, { variant: 'outline' }, 'Top') },
      ),
      React.createElement(
        Tooltip,
        { content: 'Bottom tooltip', position: 'bottom', children: React.createElement(Button, { variant: 'outline' }, 'Bottom') },
      ),
      React.createElement(
        Tooltip,
        { content: 'Left tooltip', position: 'left', children: React.createElement(Button, { variant: 'outline' }, 'Left') },
      ),
      React.createElement(
        Tooltip,
        { content: 'Right tooltip', position: 'right', children: React.createElement(Button, { variant: 'outline' }, 'Right') },
      )
    ),
};
