import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    environment: 'node',
    // The live-mount arm boots a real `createGguiServer` on an
    // ephemeral port per suite — allow it time on cold CI runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
