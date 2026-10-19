import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../test-support/no-ambient-aws.mjs'],
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
