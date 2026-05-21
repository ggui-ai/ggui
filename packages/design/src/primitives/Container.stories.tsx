import type { Meta, StoryObj } from '@storybook/react';
import { Container } from './Container';

const innerStyle = {
  padding: '16px',
  background: 'var(--ggui-color-primary-50, #f0f9ff)',
  border: '1px dashed var(--ggui-color-primary-300, #7dd3fc)',
  borderRadius: '8px',
  fontSize: '14px',
  color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
} as const;

const meta: Meta<typeof Container> = {
  title: 'Primitives/Layout/Container',
  component: Container,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  argTypes: {
    maxWidth: {
      control: 'select',
      options: ['xs', 'sm', 'md', 'lg', 'xl', '2xl', '3xl', 'full'],
    },
    center: { control: 'boolean' },
    padding: { control: 'number' },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    maxWidth: 'lg',
    padding: 16,
    children: <div style={innerStyle}>Container content (max-width: lg)</div>,
  },
};

export const Small: Story = {
  args: {
    maxWidth: 'sm',
    padding: 16,
    children: <div style={innerStyle}>Small container</div>,
  },
};

export const ExtraLarge: Story = {
  args: {
    maxWidth: 'xl',
    padding: 16,
    children: <div style={innerStyle}>Extra large container</div>,
  },
};

export const NotCentered: Story = {
  args: {
    maxWidth: 'md',
    center: false,
    padding: 16,
    children: <div style={innerStyle}>Left-aligned container</div>,
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', padding: '16px' }}>
      {(['xs', 'sm', 'md', 'lg', 'xl'] as const).map((size) => (
        <Container key={size} maxWidth={size}>
          <div style={innerStyle}>maxWidth: {size}</div>
        </Container>
      ))}
    </div>
  ),
};
