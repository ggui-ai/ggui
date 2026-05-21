import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Link } from './Link';

const meta: Meta<typeof Link> = {
  title: 'Primitives/Interactive/Link',
  component: Link,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  argTypes: {
    href: { control: 'text' },
    external: { control: 'boolean' },
    underline: {
      control: 'select',
      options: ['always', 'hover', 'none'],
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
    children: 'Default Link',
    href: '#',
  },
};

export const External: Story = {
  args: {
    children: 'External Link',
    href: 'https://example.com',
    external: true,
  },
};

export const AlwaysUnderlined: Story = {
  args: {
    children: 'Always Underlined',
    href: '#',
    underline: 'always',
  },
};

export const NoUnderline: Story = {
  args: {
    children: 'No Underline',
    href: '#',
    underline: 'none',
  },
};

export const CustomColor: Story = {
  args: {
    children: 'Custom Tone Link',
    href: '#',
    tone: 'error',
  },
};

export const AllVariants: Story = {
  render: () =>
    React.createElement(
      'div',
      { style: { display: 'flex', flexDirection: 'column', gap: '16px' } },
      React.createElement(Link, { href: '#', underline: 'hover' }, 'Underline on Hover (default)'),
      React.createElement(Link, { href: '#', underline: 'always' }, 'Always Underlined'),
      React.createElement(Link, { href: '#', underline: 'none' }, 'No Underline'),
      React.createElement(
        Link,
        { href: 'https://example.com', external: true },
        'External Link with Icon'
      ),
      React.createElement(Link, { href: '#', tone: 'error' }, 'Custom Tone Link')
    ),
};
