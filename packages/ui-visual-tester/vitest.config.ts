import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['../../test-support/no-ambient-aws.mjs'],
    include: ['src/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: 'forks',
    // One test file at a time, each in a fresh process (vitest 4 removed
    // `poolOptions.forks.singleFork`; `isolate` stays at its default `true`, so
    // module state never carries from one file into the next).
    maxWorkers: 1,
  },
});
