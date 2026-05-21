import type { Meta, StoryObj } from '@storybook/react';
import { SearchField } from './SearchField';

const meta: Meta<typeof SearchField> = {
  title: 'Components/SearchField',
  component: SearchField,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    loading: { control: 'boolean' },
    disabled: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    placeholder: 'Search...',
  },
};

export const WithValue: Story = {
  args: {
    value: 'React components',
    placeholder: 'Search...',
  },
};

export const Loading: Story = {
  args: {
    value: 'Searching...',
    loading: true,
    placeholder: 'Search...',
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
    placeholder: 'Search disabled',
  },
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '300px' }}>
      <SearchField size="sm" placeholder="Small search" />
      <SearchField size="md" placeholder="Medium search (default)" />
      <SearchField size="lg" placeholder="Large search" />
    </div>
  ),
};

// "WithClear" story removed: it referenced an `onClear` prop that
// SearchField doesn't have. The input uses `type="search"`, which gives
// browsers a native clear affordance — no JS handler is needed. The
// existing `WithValue` story above already covers the populated-input
// state. Re-add a clear-button story if SearchField gains a real
// `onClear` prop.
