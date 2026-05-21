import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { CommandPalette } from './CommandPalette';
import type { Command } from './types';
import { Icon } from '../primitives/Icon';

const sampleCommands: Command[] = [
  { id: 'new-project', label: 'Create New Project', description: 'Start a new project from scratch', group: 'Actions', shortcut: 'Ctrl+N', icon: React.createElement(Icon, { name: 'plus', size: 16 }) },
  { id: 'open-file', label: 'Open File', description: 'Browse and open a file', group: 'Actions', shortcut: 'Ctrl+O', icon: React.createElement(Icon, { name: 'file', size: 16 }) },
  { id: 'save', label: 'Save', description: 'Save the current document', group: 'Actions', shortcut: 'Ctrl+S', icon: React.createElement(Icon, { name: 'save', size: 16 }) },
  { id: 'goto-dashboard', label: 'Go to Dashboard', group: 'Navigation', icon: React.createElement(Icon, { name: 'grid', size: 16 }) },
  { id: 'goto-settings', label: 'Go to Settings', group: 'Navigation', icon: React.createElement(Icon, { name: 'settings', size: 16 }) },
  { id: 'goto-analytics', label: 'Go to Analytics', group: 'Navigation', icon: React.createElement(Icon, { name: 'bar-chart', size: 16 }) },
  { id: 'toggle-theme', label: 'Toggle Dark Mode', group: 'Preferences', shortcut: 'Ctrl+Shift+D' },
  { id: 'sign-out', label: 'Sign Out', group: 'Account', disabled: false },
];

const meta: Meta<typeof CommandPalette> = {
  title: 'Compositions/CommandPalette',
  component: CommandPalette,
  tags: ['autodocs'],
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    open: true,
    commands: sampleCommands,
    onClose: () => {},
    onSelect: () => {},
    placeholder: 'Search commands...',
  },
};

export const WithRecentCommands: Story = {
  args: {
    open: true,
    commands: sampleCommands,
    onClose: () => {},
    onSelect: () => {},
    recentIds: ['new-project', 'goto-dashboard'],
  },
};

export const Loading: Story = {
  args: {
    open: true,
    commands: [],
    onClose: () => {},
    onSelect: () => {},
    loading: true,
  },
};

export const EmptyResults: Story = {
  render: function Render() {
    return React.createElement(CommandPalette, {
      open: true,
      commands: [],
      onClose: () => {},
      onSelect: () => {},
      placeholder: 'Search commands...',
    });
  },
};
