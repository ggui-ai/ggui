import type { Meta, StoryObj } from '@storybook/react';
import { Box } from './Box';
import type { BoxProps } from './types';

// Typed against `BoxProps` (own props), not `typeof Box`: `Box`'s
// public type is `WithTrait<BoxProps>` — a discriminated union on
// `as` — which Storybook's `StoryObj` arg inference collapses to
// `never`.
const meta: Meta<BoxProps> = {
  title: 'Primitives/Layout/Box',
  component: Box,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    padding: { control: 'number' },
    paddingX: { control: 'number' },
    paddingY: { control: 'number' },
    margin: { control: 'number' },
    surface: {
      control: 'select',
      options: ['default', 'elevated', 'sunken', 'accent', 'inverted', 'transparent'],
    },
    radius: { control: 'text' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const sampleContent = (
  <span style={{ fontSize: '14px', color: '#374151' }}>Box content</span>
);

export const Default: Story = {
  args: {
    children: sampleContent,
    padding: 16,
  },
};

export const WithBackground: Story = {
  args: {
    children: sampleContent,
    padding: 24,
    surface: 'sunken',
    borderRadius: 8,
  },
};

export const PaddingXY: Story = {
  args: {
    children: sampleContent,
    paddingX: 32,
    paddingY: 12,
    surface: 'accent',
    borderRadius: 8,
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <Box padding={16} surface="sunken">
        <span>Padding 16</span>
      </Box>
      <Box padding={24} surface="sunken" radius="lg">
        <span>Padding 24, rounded</span>
      </Box>
      <Box paddingX={32} paddingY={8} surface="accent" radius="md">
        <span>PaddingX 32, PaddingY 8</span>
      </Box>
      <Box padding={16} margin={16} assetColor="#fffbeb" assetSemantic="warning-tint">
        <span>With margin 16</span>
      </Box>
    </div>
  ),
};
