import type { Meta, StoryObj } from '@storybook/react';
import { Stack } from './Stack';
import { Box } from './Box';
import type { StackProps } from './types';

// Typed against `StackProps` (own props), not `typeof Stack`:
// `Stack`'s public type is `WithTrait<StackProps>` — a discriminated
// union on `as` — which Storybook's `StoryObj` arg inference collapses
// to `never`.
const meta: Meta<StackProps> = {
  title: 'Primitives/Layout/Stack',
  component: Stack,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    direction: {
      control: 'select',
      options: ['vertical', 'horizontal'],
    },
    align: {
      control: 'select',
      options: ['start', 'center', 'end', 'stretch'],
    },
    justify: {
      control: 'select',
      options: ['start', 'center', 'end', 'between', 'around', 'evenly'],
    },
    wrap: { control: 'boolean' },
    gap: { control: 'number' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const DemoBox = ({ children }: { children: React.ReactNode }) => (
  <Box padding={16} surface="sunken" radius="sm">
    {children}
  </Box>
);

export const Vertical: Story = {
  args: {
    direction: 'vertical',
    gap: 12,
  },
  render: (args) => (
    <Stack {...args}>
      <DemoBox>Item 1</DemoBox>
      <DemoBox>Item 2</DemoBox>
      <DemoBox>Item 3</DemoBox>
    </Stack>
  ),
};

export const Horizontal: Story = {
  args: {
    direction: 'horizontal',
    gap: 12,
  },
  render: (args) => (
    <Stack {...args}>
      <DemoBox>Item 1</DemoBox>
      <DemoBox>Item 2</DemoBox>
      <DemoBox>Item 3</DemoBox>
    </Stack>
  ),
};

export const AlignCenter: Story = {
  args: {
    direction: 'horizontal',
    gap: 12,
    align: 'center',
  },
  render: (args) => (
    <Stack {...args} style={{ height: '100px', background: '#f3f4f6' }}>
      <DemoBox>Short</DemoBox>
      <DemoBox>Medium Height</DemoBox>
      <DemoBox>Tall<br/>Item</DemoBox>
    </Stack>
  ),
};

export const JustifyBetween: Story = {
  args: {
    direction: 'horizontal',
    justify: 'between',
  },
  render: (args) => (
    <Stack {...args} style={{ width: '400px', background: '#f3f4f6', padding: '8px' }}>
      <DemoBox>Left</DemoBox>
      <DemoBox>Center</DemoBox>
      <DemoBox>Right</DemoBox>
    </Stack>
  ),
};

export const Wrapping: Story = {
  args: {
    direction: 'horizontal',
    gap: 8,
    wrap: true,
  },
  render: (args) => (
    <Stack {...args} style={{ width: '300px', background: '#f3f4f6', padding: '8px' }}>
      {Array.from({ length: 8 }).map((_, i) => (
        <DemoBox key={i}>Item {i + 1}</DemoBox>
      ))}
    </Stack>
  ),
};

export const NestedStacks: Story = {
  render: () => (
    <Stack direction="vertical" gap={16}>
      <Stack direction="horizontal" gap={8}>
        <DemoBox>Row 1, Col 1</DemoBox>
        <DemoBox>Row 1, Col 2</DemoBox>
      </Stack>
      <Stack direction="horizontal" gap={8}>
        <DemoBox>Row 2, Col 1</DemoBox>
        <DemoBox>Row 2, Col 2</DemoBox>
        <DemoBox>Row 2, Col 3</DemoBox>
      </Stack>
    </Stack>
  ),
};
