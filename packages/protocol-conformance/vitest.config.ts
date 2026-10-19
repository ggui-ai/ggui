import { defineConfig } from 'vitest/config';

// Tests never reach a real AWS account through ambient credentials: the guard loads first.
export default defineConfig({
  test: {
    setupFiles: ['../../test-support/no-ambient-aws.mjs'],
  },
});
