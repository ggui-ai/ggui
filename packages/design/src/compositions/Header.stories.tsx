import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Header } from './Header';
import { Button } from '../primitives/Button';
import { Avatar } from '../primitives/Avatar';

const meta: Meta<typeof Header> = {
  title: 'Compositions/Header',
  component: Header,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    logo: React.createElement(
      'span',
      { style: { fontWeight: 700, fontSize: '18px', color: '#0284c7' } },
      'ggui'
    ),
    navigation: React.createElement(
      'div',
      { style: { display: 'flex', gap: '24px', fontSize: '14px' } },
      React.createElement('a', { href: '#', style: { color: '#0284c7', textDecoration: 'none', fontWeight: 500 } }, 'Dashboard'),
      React.createElement('a', { href: '#', style: { color: '#374151', textDecoration: 'none' } }, 'Projects'),
      React.createElement('a', { href: '#', style: { color: '#374151', textDecoration: 'none' } }, 'Analytics'),
      React.createElement('a', { href: '#', style: { color: '#374151', textDecoration: 'none' } }, 'Settings')
    ),
  },
};

export const WithActions: Story = {
  args: {
    logo: React.createElement(
      'span',
      { style: { fontWeight: 700, fontSize: '18px', color: '#0284c7' } },
      'ggui'
    ),
    navigation: React.createElement(
      'div',
      { style: { display: 'flex', gap: '24px', fontSize: '14px' } },
      React.createElement('a', { href: '#', style: { color: '#374151', textDecoration: 'none' } }, 'Docs'),
      React.createElement('a', { href: '#', style: { color: '#374151', textDecoration: 'none' } }, 'Pricing'),
      React.createElement('a', { href: '#', style: { color: '#374151', textDecoration: 'none' } }, 'Blog')
    ),
    actions: React.createElement(
      React.Fragment,
      null,
      React.createElement(Button, { variant: 'outline', size: 'sm' }, 'Sign In'),
      React.createElement(Button, { size: 'sm' }, 'Get Started'),
      React.createElement(Avatar, { name: 'Alice Chen', size: 'sm' })
    ),
  },
};

export const Sticky: Story = {
  args: {
    logo: React.createElement(
      'span',
      { style: { fontWeight: 700, fontSize: '18px', color: '#0284c7' } },
      'ggui'
    ),
    sticky: true,
    navigation: React.createElement(
      'div',
      { style: { display: 'flex', gap: '24px', fontSize: '14px' } },
      React.createElement('a', { href: '#', style: { color: '#374151', textDecoration: 'none' } }, 'Home'),
      React.createElement('a', { href: '#', style: { color: '#374151', textDecoration: 'none' } }, 'About')
    ),
  },
};

export const NoBorder: Story = {
  args: {
    logo: React.createElement(
      'span',
      { style: { fontWeight: 700, fontSize: '18px', color: '#0284c7' } },
      'ggui'
    ),
    bordered: false,
    background: '#f9fafb',
  },
};
