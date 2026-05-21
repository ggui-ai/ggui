import type { Meta, StoryObj } from '@storybook/react';
import { Icon } from './Icon';

const builtInNames = [
  'check', 'x', 'chevron-down', 'chevron-up', 'chevron-left', 'chevron-right',
  'search', 'plus', 'minus', 'menu', 'user', 'settings',
];

const meta: Meta<typeof Icon> = {
  title: 'Primitives/Media/Icon',
  component: Icon,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    name: {
      control: 'select',
      options: builtInNames,
    },
    size: { control: 'number' },
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
    name: 'check',
    size: 24,
  },
};

export const Large: Story = {
  args: {
    name: 'search',
    size: 48,
  },
};

export const Colored: Story = {
  args: {
    name: 'user',
    size: 32,
    tone: 'emphasized',
  },
};

export const CustomSvg: Story = {
  args: {
    size: 24,
    children: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
      </svg>
    ),
  },
};

export const UnknownName: Story = {
  args: {
    name: 'nonexistent',
    size: 24,
  },
};

export const AllVariants: Story = {
  render: () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
        {builtInNames.map((name) => (
          <div key={name} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '4px' }}>
            <Icon name={name} size={24} />
            <span style={{ fontSize: '10px', color: '#6b7280' }}>{name}</span>
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
        <Icon name="check" size={16} />
        <Icon name="check" size={24} />
        <Icon name="check" size={32} />
        <Icon name="check" size={48} />
      </div>
    </div>
  ),
};
