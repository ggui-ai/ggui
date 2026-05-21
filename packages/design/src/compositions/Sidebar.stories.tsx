import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Sidebar } from './Sidebar';
import type { SidebarItem } from './types';
import { Icon } from '../primitives/Icon';

const sampleItems: SidebarItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: React.createElement(Icon, { name: 'grid', size: 18 }) },
  { id: 'projects', label: 'Projects', icon: React.createElement(Icon, { name: 'layers', size: 18 }) },
  { id: 'messages', label: 'Messages', icon: React.createElement(Icon, { name: 'message-circle', size: 18 }), badge: React.createElement('span', { style: { fontSize: '11px', backgroundColor: '#ef4444', color: '#fff', borderRadius: '9999px', padding: '1px 6px' } }, '3') },
  { id: 'analytics', label: 'Analytics', icon: React.createElement(Icon, { name: 'bar-chart', size: 18 }) },
  { id: 'settings', label: 'Settings', icon: React.createElement(Icon, { name: 'settings', size: 18 }) },
];

const itemsWithChildren: SidebarItem[] = [
  { id: 'dashboard', label: 'Dashboard', icon: React.createElement(Icon, { name: 'grid', size: 18 }) },
  {
    id: 'projects',
    label: 'Projects',
    icon: React.createElement(Icon, { name: 'layers', size: 18 }),
    children: [
      { id: 'proj-active', label: 'Active' },
      { id: 'proj-archived', label: 'Archived' },
      { id: 'proj-drafts', label: 'Drafts' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: React.createElement(Icon, { name: 'settings', size: 18 }),
    children: [
      { id: 'settings-general', label: 'General' },
      { id: 'settings-billing', label: 'Billing' },
      { id: 'settings-team', label: 'Team', disabled: true },
    ],
  },
];

const meta: Meta<typeof Sidebar> = {
  title: 'Compositions/Sidebar',
  component: Sidebar,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
  },
  decorators: [
    (Story) =>
      React.createElement(
        'div',
        { style: { height: '500px', display: 'flex' } },
        React.createElement(Story, null)
      ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    items: sampleItems,
    activeId: 'dashboard',
  },
};

export const Collapsed: Story = {
  args: {
    items: sampleItems,
    activeId: 'projects',
    collapsed: true,
  },
};

export const WithSubItems: Story = {
  args: {
    items: itemsWithChildren,
    activeId: 'proj-active',
  },
};

export const WithHeaderAndFooter: Story = {
  args: {
    items: sampleItems,
    activeId: 'dashboard',
    header: React.createElement(
      'div',
      { style: { fontWeight: 700, fontSize: '16px', color: '#0284c7' } },
      'ggui'
    ),
    footer: React.createElement(
      'div',
      { style: { fontSize: '12px', color: '#6b7280' } },
      'v1.0.0'
    ),
  },
};
