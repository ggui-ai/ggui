import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { RadioGroup } from './RadioGroup';

const defaultOptions = [
  { value: 'option1', label: 'Option 1' },
  { value: 'option2', label: 'Option 2' },
  { value: 'option3', label: 'Option 3' },
];

const optionsWithDescriptions = [
  { value: 'free', label: 'Free', description: 'Basic features for personal use' },
  { value: 'pro', label: 'Pro', description: 'Advanced features for professionals' },
  { value: 'enterprise', label: 'Enterprise', description: 'Custom solutions for teams' },
];

const meta: Meta<typeof RadioGroup> = {
  title: 'Primitives/Form/RadioGroup',
  component: RadioGroup,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    direction: {
      control: 'select',
      options: ['vertical', 'horizontal'],
    },
    disabled: { control: 'boolean' },
    label: { control: 'text' },
    error: { control: 'text' },
    value: { control: 'text' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    options: defaultOptions,
    label: 'Select an option',
  },
};

export const WithValue: Story = {
  args: {
    options: defaultOptions,
    label: 'Select an option',
    value: 'option2',
  },
};

export const Horizontal: Story = {
  args: {
    options: defaultOptions,
    label: 'Choose one',
    direction: 'horizontal',
  },
};

export const WithDescriptions: Story = {
  args: {
    options: optionsWithDescriptions,
    label: 'Select a plan',
    value: 'pro',
  },
};

export const WithError: Story = {
  args: {
    options: defaultOptions,
    label: 'Required field',
    error: 'Please select an option',
  },
};

export const Disabled: Story = {
  args: {
    options: defaultOptions,
    label: 'Disabled group',
    value: 'option1',
    disabled: true,
  },
};

export const AllVariants: Story = {
  render: () =>
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '32px', maxWidth: '400px' } },
      React.createElement(RadioGroup, {
        label: 'Vertical (default)',
        options: defaultOptions,
        value: 'option1',
      }),
      React.createElement(RadioGroup, {
        label: 'Horizontal',
        options: defaultOptions,
        value: 'option2',
        direction: 'horizontal',
      }),
      React.createElement(RadioGroup, {
        label: 'With Descriptions',
        options: optionsWithDescriptions,
        value: 'pro',
      }),
      React.createElement(RadioGroup, {
        label: 'With Error',
        options: defaultOptions,
        error: 'This field is required',
      }),
      React.createElement(RadioGroup, {
        label: 'Disabled',
        options: defaultOptions,
        value: 'option1',
        disabled: true,
      })
    ),
};
