import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Toggle } from './Toggle';

const meta: Meta<typeof Toggle> = {
  title: 'Primitives/Form/Toggle',
  component: Toggle,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['sm', 'md', 'lg'],
    },
    disabled: { control: 'boolean' },
    checked: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    label: 'Enable notifications',
  },
};

export const Checked: Story = {
  args: {
    label: 'Notifications enabled',
    checked: true,
  },
};

export const Disabled: Story = {
  args: {
    label: 'Feature locked',
    disabled: true,
  },
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <Toggle label="Small toggle" size="sm" />
      <Toggle label="Medium toggle" size="md" />
      <Toggle label="Large toggle" size="lg" />
    </div>
  ),
};

export const Interactive: Story = {
  render: () => {
    const [checked, setChecked] = useState(false);
    return (
      <Toggle
        label={checked ? 'Dark mode enabled' : 'Dark mode disabled'}
        checked={checked}
        onChange={setChecked}
      />
    );
  },
};
