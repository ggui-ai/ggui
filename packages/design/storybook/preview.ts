import type { Preview } from '@storybook/react';
import React from 'react';

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
      // Inject MotionKeyframes and ThemeProvider for all stories
      const { ThemeProvider } = require('../src/themes/ThemeProvider');
      const { MotionKeyframes } = require('../src/primitives/motion');

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
