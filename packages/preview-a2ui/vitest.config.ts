import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../test-support/no-ambient-aws.mjs'],
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
