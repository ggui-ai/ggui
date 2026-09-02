import type { Preview } from '@storybook/react-vite';
import React from 'react';
import { ThemeProvider } from '../src/themes/ThemeProvider';
import { MotionKeyframes } from '../src/primitives/motion';

const preview: Preview = {
  parameters: {
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    backgrounds: {
      default: 'light',
      values: [
        { name: 'light', value: '#ffffff' },
        { name: 'gray', value: '#f3f4f6' },
        { name: 'dark', value: '#111827' },
      ],
    },
    layout: 'centered',
  },
  decorators: [
    (Story) => {
      // Inject MotionKeyframes and ThemeProvider for all stories (static
      // imports — Storybook 10 loads config as ESM; no `require` shim).

      return React.createElement(
        ThemeProvider,
        {},
        React.createElement(MotionKeyframes),
        React.createElement(
          'div',
          {
            style: {
              fontFamily: 'system-ui, -apple-system, sans-serif',
              padding: '24px',
            },
          },
          React.createElement(Story)
        )
      );
    },
  ],
  tags: ['autodocs'],
};

export default preview;
