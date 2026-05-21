import type { Meta, StoryObj } from '@storybook/react';
import { Select } from './Select';

const meta: Meta<typeof Select> = {
  title: 'Primitives/Form/Select',
  component: Select,
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
    required: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const countryOptions = [
  { value: 'us', label: 'United States' },
  { value: 'uk', label: 'United Kingdom' },
  { value: 'ca', label: 'Canada' },
  { value: 'au', label: 'Australia' },
  { value: 'de', label: 'Germany' },
];

export const Default: Story = {
  args: {
    label: 'Country',
    options: countryOptions,
    placeholder: 'Select a country',
  },
};

export const WithValue: Story = {
  args: {
    label: 'Country',
    options: countryOptions,
    value: 'us',
  },
};

export const WithError: Story = {
  args: {
    label: 'Country',
    options: countryOptions,
    placeholder: 'Select a country',
    error: 'Please select a country',
    required: true,
  },
};

export const WithHelperText: Story = {
  args: {
    label: 'Country',
    options: countryOptions,
    placeholder: 'Select a country',
    helperText: 'Select your country of residence',
  },
};

export const Disabled: Story = {
  args: {
    label: 'Country',
    options: countryOptions,
    value: 'us',
    disabled: true,
  },
};

export const Sizes: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '300px' }}>
      <Select label="Small" options={countryOptions} size="sm" placeholder="Select..." />
      <Select label="Medium" options={countryOptions} size="md" placeholder="Select..." />
      <Select label="Large" options={countryOptions} size="lg" placeholder="Select..." />
    </div>
  ),
};
