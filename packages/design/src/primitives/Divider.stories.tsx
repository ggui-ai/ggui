import type { Meta, StoryObj } from '@storybook/react';
import { Divider } from './Divider';

const meta: Meta<typeof Divider> = {
  title: 'Primitives/Layout/Divider',
  component: Divider,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    orientation: {
      control: 'select',
      options: ['horizontal', 'vertical'],
    },
    margin: { control: 'number' },
    tone: {
      control: 'select',
      options: [
        undefined,
        'default',
        'muted',
        'subtle',
        'emphasized',
        'loud',
        'success',
        'warning',
        'error',
        'info',
        'inverse',
        'inherit',
      ],
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    orientation: 'horizontal',
  },
};

export const CustomColor: Story = {
  args: {
    orientation: 'horizontal',
    tone: 'emphasized',
  },
};

export const SmallMargin: Story = {
  args: {
    orientation: 'horizontal',
    margin: 8,
  },
};

export const Vertical: Story = {
  decorators: [
    (Story) => (
      <div style={{ display: 'flex', alignItems: 'stretch', height: '80px' }}>
        <span style={{ padding: '0 8px' }}>Left</span>
        <Story />
        <span style={{ padding: '0 8px' }}>Right</span>
      </div>
    ),
  ],
  args: {
    orientation: 'vertical',
    margin: 8,
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <span style={{ fontSize: '14px', color: '#6b7280' }}>Horizontal (default)</span>
      <Divider />
      <span style={{ fontSize: '14px', color: '#6b7280' }}>Custom tone</span>
      <Divider tone="emphasized" />
      <span style={{ fontSize: '14px', color: '#6b7280' }}>Small margin</span>
      <Divider margin={4} />
      <span style={{ fontSize: '14px', color: '#6b7280' }}>Vertical</span>
      <div style={{ display: 'flex', alignItems: 'stretch', height: '40px' }}>
        <span>A</span>
        <Divider orientation="vertical" margin={12} />
        <span>B</span>
        <Divider orientation="vertical" margin={12} />
        <span>C</span>
      </div>
    </div>
  ),
};
