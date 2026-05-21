import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TextArea } from './TextArea';

const meta: Meta<typeof TextArea> = {
  title: 'Primitives/Form/TextArea',
  component: TextArea,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    label: { control: 'text' },
    placeholder: { control: 'text' },
    value: { control: 'text' },
    rows: { control: { type: 'number', min: 1, max: 20 } },
    error: { control: 'text' },
    helperText: { control: 'text' },
    required: { control: 'boolean' },
    disabled: { control: 'boolean' },
    maxLength: { control: 'number' },
    showCount: { control: 'boolean' },
    autoResize: { control: 'boolean' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const decorator = (Story: React.ComponentType) =>
  React.createElement('div', { style: { width: '320px' } }, React.createElement(Story));

export const Default: Story = {
  args: {
    placeholder: 'Enter your text here...',
  },
  decorators: [decorator],
};

export const WithLabel: Story = {
  args: {
    label: 'Description',
    placeholder: 'Enter a description...',
  },
  decorators: [decorator],
};

export const Required: Story = {
  args: {
    label: 'Comments',
    placeholder: 'Required field...',
    required: true,
  },
  decorators: [decorator],
};

export const WithError: Story = {
  args: {
    label: 'Bio',
    value: 'Too short',
    error: 'Bio must be at least 50 characters',
  },
  decorators: [decorator],
};

export const WithHelperText: Story = {
  args: {
    label: 'Notes',
    placeholder: 'Add notes...',
    helperText: 'Optional. Maximum 500 characters.',
  },
  decorators: [decorator],
};

export const WithCharacterCount: Story = {
  args: {
    label: 'Message',
    placeholder: 'Type your message...',
    value: 'Hello, world!',
    maxLength: 200,
    showCount: true,
  },
  decorators: [decorator],
};

export const Disabled: Story = {
  args: {
    label: 'Disabled',
    value: 'This field is disabled',
    disabled: true,
  },
  decorators: [decorator],
};

export const CustomRows: Story = {
  args: {
    label: 'Large Text Area',
    placeholder: 'This has 8 rows...',
    rows: 8,
  },
  decorators: [decorator],
};

export const AllVariants: Story = {
  render: () =>
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '24px', width: '320px' } },
      React.createElement(TextArea, {
        label: 'Default',
        placeholder: 'Enter text...',
      }),
      React.createElement(TextArea, {
        label: 'Required',
        placeholder: 'Required field...',
        required: true,
      }),
      React.createElement(TextArea, {
        label: 'With Error',
        value: 'Bad input',
        error: 'Please correct this field',
      }),
      React.createElement(TextArea, {
        label: 'With Helper',
        placeholder: 'Enter details...',
        helperText: 'Provide as much detail as possible',
      }),
      React.createElement(TextArea, {
        label: 'Character Count',
        value: 'Some text',
        maxLength: 100,
        showCount: true,
      }),
      React.createElement(TextArea, {
        label: 'Disabled',
        value: 'Cannot edit',
        disabled: true,
      })
    ),
};
