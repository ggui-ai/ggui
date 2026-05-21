import type { Meta, StoryObj } from '@storybook/react';
import { Avatar } from './Avatar';

const meta: Meta<typeof Avatar> = {
  title: 'Primitives/Feedback/Avatar',
  component: Avatar,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    size: {
      control: 'select',
      options: ['xs', 'sm', 'md', 'lg', 'xl'],
    },
    shape: {
      control: 'select',
      options: ['circle', 'square'],
    },
    src: { control: 'text' },
    name: { control: 'text' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    name: 'Jane Doe',
    size: 'md',
  },
};

export const WithImage: Story = {
  args: {
    src: 'https://i.pravatar.cc/150?u=jane',
    name: 'Jane Doe',
    size: 'md',
  },
};

export const Square: Story = {
  args: {
    name: 'Jane Doe',
    shape: 'square',
    size: 'md',
  },
};

export const NoName: Story = {
  args: {
    size: 'md',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <Avatar name="Alice Brown" size="xs" />
        <Avatar name="Alice Brown" size="sm" />
        <Avatar name="Alice Brown" size="md" />
        <Avatar name="Alice Brown" size="lg" />
        <Avatar name="Alice Brown" size="xl" />
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <Avatar name="Alice Brown" shape="circle" />
        <Avatar name="Alice Brown" shape="square" />
      </div>
      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
        <Avatar name="Alice Brown" />
        <Avatar name="Bob Chen" />
        <Avatar name="Carol Davis" />
        <Avatar name="David Evans" />
        <Avatar name="Eve Foster" />
      </div>
    </div>
  ),
};
