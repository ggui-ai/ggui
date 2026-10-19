import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../test-support/no-ambient-aws.mjs'],
    environment: 'jsdom',
    globals: true,
  },
});
