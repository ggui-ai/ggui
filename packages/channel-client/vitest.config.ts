import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // jsdom for WebSocket/fetch globals — same posture as iframe-runtime.
    environment: 'jsdom',
    globals: true,
  },
});
