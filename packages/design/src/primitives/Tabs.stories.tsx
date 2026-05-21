import type { Meta, StoryObj } from '@storybook/react';
import { Tabs } from './Tabs';

const meta: Meta<typeof Tabs> = {
  title: 'Primitives/Navigation/Tabs',
  component: Tabs,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    variant: {
      control: 'select',
      options: ['line', 'pills', 'enclosed'],
    },
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    fullWidth: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const items = [
  { key: 'overview', label: 'Overview', content: 'Overview content goes here. This is a description of the project.' },
  { key: 'features', label: 'Features', content: 'Feature list: Authentication, Dashboard, Analytics, API.' },
  { key: 'pricing', label: 'Pricing', content: 'Free tier available. Pro plan starts at $19/month.' },
];

export const Line: Story = {
  args: {
    items,
    variant: 'line',
  },
};

export const Pills: Story = {
  args: {
    items,
    variant: 'pills',
  },
};

export const Enclosed: Story = {
  args: {
    items,
    variant: 'enclosed',
  },
};

export const Small: Story = {
  args: {
    items,
    size: 'sm',
  },
};

export const Large: Story = {
  args: {
    items,
    size: 'lg',
  },
};

export const FullWidth: Story = {
  args: {
    items,
    fullWidth: true,
  },
};

export const WithDisabled: Story = {
  args: {
    items: [
      ...items,
      { key: 'admin', label: 'Admin', content: 'Admin panel.', disabled: true },
    ],
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '32px' }}>
      <div>
        <h3 style={{ marginBottom: '8px', fontSize: '14px', color: '#6b7280' }}>Line</h3>
        <Tabs items={items} variant="line" />
      </div>
      <div>
        <h3 style={{ marginBottom: '8px', fontSize: '14px', color: '#6b7280' }}>Pills</h3>
        <Tabs items={items} variant="pills" />
      </div>
      <div>
        <h3 style={{ marginBottom: '8px', fontSize: '14px', color: '#6b7280' }}>Enclosed</h3>
        <Tabs items={items} variant="enclosed" />
      </div>
    </div>
  ),
};
