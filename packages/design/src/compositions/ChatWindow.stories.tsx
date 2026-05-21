import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { ChatWindow } from './ChatWindow';
import type { ChatMessage } from './types';

const sampleMessages: ChatMessage[] = [
  {
    id: '1',
    content: 'Hey, how is the design system coming along?',
    sender: { id: 'user-2', name: 'Alice Chen', avatar: undefined },
    timestamp: '10:30 AM',
    status: 'read',
  },
  {
    id: '2',
    content: 'Going well! Just finished the token system. Working on compositions now.',
    sender: { id: 'user-1', name: 'You' },
    timestamp: '10:32 AM',
    status: 'delivered',
  },
  {
    id: '3',
    content: 'That sounds great. Can you share a preview when ready?',
    sender: { id: 'user-2', name: 'Alice Chen' },
    timestamp: '10:33 AM',
  },
  {
    id: '4',
    content: 'Sure, I will push the Storybook stories shortly.',
    sender: { id: 'user-1', name: 'You' },
    timestamp: '10:34 AM',
    status: 'sent',
  },
];

const meta: Meta<typeof ChatWindow> = {
  title: 'Compositions/ChatWindow',
  component: ChatWindow,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
  },
  decorators: [
    (Story) =>
      React.createElement(
        'div',
        { style: { height: '500px', maxWidth: '480px' } },
        React.createElement(Story, null)
      ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    messages: sampleMessages,
    currentUserId: 'user-1',
    placeholder: 'Type a message...',
  },
};

export const Empty: Story = {
  args: {
    messages: [],
    currentUserId: 'user-1',
    placeholder: 'Start a conversation...',
  },
};

export const Loading: Story = {
  args: {
    messages: [],
    currentUserId: 'user-1',
    loading: true,
  },
};

export const WithTypingIndicator: Story = {
  args: {
    messages: sampleMessages,
    currentUserId: 'user-1',
    typing: { name: 'Alice Chen' },
  },
};

export const WithHeader: Story = {
  args: {
    messages: sampleMessages,
    currentUserId: 'user-1',
    header: React.createElement(
      'div',
      {
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          fontWeight: 600,
          fontSize: '14px',
        },
      },
      React.createElement(
        'span',
        {
          style: {
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            backgroundColor: '#22c55e',
            display: 'inline-block',
          },
        }
      ),
      'Alice Chen'
    ),
  },
};
