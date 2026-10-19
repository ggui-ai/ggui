import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['../../test-support/no-ambient-aws.mjs', './src/test-setup.ts'],
  },
});
