import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Heavy esbuild/render/compile tests cross vitest's 5000ms default
    // under cold-cache 2-core CI concurrency; match the genuine work
    // (mirrors @ggui-ai/ui-gen). A real hang still surfaces in-budget.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
