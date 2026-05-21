import type { Meta, StoryObj } from '@storybook/react';
import { Heading } from './Heading';

const meta: Meta<typeof Heading> = {
  title: 'Primitives/Typography/Heading',
  component: Heading,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  argTypes: {
    level: {
      control: 'select',
      options: [1, 2, 3, 4, 5, 6],
    },
    align: {
      control: 'select',
      options: ['left', 'center', 'right'],
    },
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
    children: 'Heading Text',
    level: 2,
  },
};

export const H1: Story = {
  args: {
    children: 'Heading Level 1',
    level: 1,
  },
};

export const H3: Story = {
  args: {
    children: 'Heading Level 3',
    level: 3,
  },
};

export const Centered: Story = {
  args: {
    children: 'Centered Heading',
    level: 2,
    align: 'center',
  },
};

export const CustomColor: Story = {
  args: {
    children: 'Toned Heading',
    level: 2,
    tone: 'emphasized',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <Heading level={1}>Heading 1</Heading>
      <Heading level={2}>Heading 2</Heading>
      <Heading level={3}>Heading 3</Heading>
      <Heading level={4}>Heading 4</Heading>
      <Heading level={5}>Heading 5</Heading>
      <Heading level={6}>Heading 6</Heading>
    </div>
  ),
};
