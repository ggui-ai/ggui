import type { StorybookConfig } from '@storybook/react-vite';

const config: StorybookConfig = {
  stories: ['../src/**/*.mdx', '../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  // Storybook 10 (#617): essentials + interactions live in core now;
  // addon-docs is explicit because preview.ts tags every story `autodocs`.
  addons: ['@storybook/addon-links', '@storybook/addon-docs', '@chromatic-com/storybook'],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  typescript: {
    reactDocgen: 'react-docgen-typescript',
  },
  viteFinal: async (config) => {
    return {
      ...config,
      resolve: {
        ...config.resolve,
        alias: {
          ...config.resolve?.alias,
        },
      },
    };
  },
};

export default config;
