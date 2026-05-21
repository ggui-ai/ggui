import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Slider } from './Slider';

const meta: Meta<typeof Slider> = {
  title: 'Primitives/Form/Slider',
  component: Slider,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    value: { control: { type: 'range', min: 0, max: 100, step: 1 } },
    min: { control: 'number' },
    max: { control: 'number' },
    step: { control: 'number' },
    disabled: { control: 'boolean' },
    showValue: { control: 'boolean' },
    label: { control: 'text' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    value: 50,
  },
  decorators: [(Story) => React.createElement('div', { style: { width: '300px' } }, React.createElement(Story))],
};

export const WithLabel: Story = {
  args: {
    label: 'Volume',
    value: 75,
  },
  decorators: [(Story) => React.createElement('div', { style: { width: '300px' } }, React.createElement(Story))],
};

export const WithValue: Story = {
  args: {
    label: 'Brightness',
    value: 60,
    showValue: true,
  },
  decorators: [(Story) => React.createElement('div', { style: { width: '300px' } }, React.createElement(Story))],
};

export const CustomRange: Story = {
  args: {
    label: 'Temperature',
    value: 22,
    min: 16,
    max: 30,
    step: 0.5,
    showValue: true,
  },
  decorators: [(Story) => React.createElement('div', { style: { width: '300px' } }, React.createElement(Story))],
};

export const Disabled: Story = {
  args: {
    label: 'Disabled Slider',
    value: 40,
    disabled: true,
    showValue: true,
  },
  decorators: [(Story) => React.createElement('div', { style: { width: '300px' } }, React.createElement(Story))],
};

export const AllVariants: Story = {
  render: () =>
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '24px', width: '300px' } },
      React.createElement(Slider, { label: 'Default', value: 50 }),
      React.createElement(Slider, { label: 'With Value Display', value: 75, showValue: true }),
      React.createElement(Slider, {
        label: 'Custom Range (0-10)',
        value: 7,
        min: 0,
        max: 10,
        step: 1,
        showValue: true,
      }),
      React.createElement(Slider, { label: 'At Minimum', value: 0, showValue: true }),
      React.createElement(Slider, { label: 'At Maximum', value: 100, showValue: true }),
      React.createElement(Slider, { label: 'Disabled', value: 40, disabled: true, showValue: true })
    ),
};
