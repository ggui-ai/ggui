import { describe, it, expect } from 'vitest';
import React from 'react';
import { ChatInterface } from './ChatInterface';

describe('ChatInterface', () => {
  it('exports ChatInterface component', () => {
    expect(ChatInterface).toBeDefined();
    expect(typeof ChatInterface).toBe('function');
  });

  it('accepts required props', () => {
    const element = React.createElement(ChatInterface, {
      messages: React.createElement('div', null, 'Messages'),
      input: React.createElement('input', { placeholder: 'Type...' }),
    });
    expect(element).toBeDefined();
    expect(element.props.messages).toBeDefined();
    expect(element.props.input).toBeDefined();
  });

  it('accepts optional sidebar and header', () => {
    const element = React.createElement(ChatInterface, {
      messages: React.createElement('div', null, 'Messages'),
      input: React.createElement('input'),
      header: React.createElement('h1', null, 'Chat'),
      sidebar: React.createElement('nav', null, 'Contacts'),
      sidebarPosition: 'right',
      sidebarWidth: '300px',
    });
    expect(element.props.sidebarPosition).toBe('right');
    expect(element.props.sidebarWidth).toBe('300px');
  });
});
