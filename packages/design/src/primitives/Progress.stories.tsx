import type { Meta, StoryObj } from '@storybook/react';
import { Progress } from './Progress';

const meta: Meta<typeof Progress> = {
  title: 'Primitives/Feedback/Progress',
  component: Progress,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    value: { control: { type: 'range', min: 0, max: 100 } },
    variant: {
      control: 'select',
      options: ['default', 'success', 'warning', 'error'],
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    showLabel: { control: 'boolean' },
    indeterminate: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    value: 60,
  },
};

export const WithLabel: Story = {
  args: {
    value: 75,
    showLabel: true,
  },
};

export const Success: Story = {
  args: {
    value: 100,
    variant: 'success',
    showLabel: true,
  },
};

export const Warning: Story = {
  args: {
    value: 80,
    variant: 'warning',
    showLabel: true,
  },
};

export const Error: Story = {
  args: {
    value: 30,
    variant: 'error',
    showLabel: true,
  },
};

export const Indeterminate: Story = {
  args: {
    value: 0,
    indeterminate: true,
  },
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <Progress value={60} size="sm" />
      <Progress value={60} size="md" />
      <Progress value={60} size="lg" />
    </div>
  ),
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <Progress value={25} variant="default" showLabel />
      <Progress value={50} variant="success" showLabel />
      <Progress value={75} variant="warning" showLabel />
      <Progress value={90} variant="error" showLabel />
    </div>
  ),
};
