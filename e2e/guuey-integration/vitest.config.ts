import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.integration.test.ts'],
    environment: 'node',
    server: {
      deps: {
        // @guuey/agent-client's published ESM uses extensionless
        // relative imports (Metro-resolvable, not Node-resolvable).
        // Inline it so Vite's resolver handles the specifiers.
        inline: ['@guuey/agent-client'],
      },
    },
    // The live-mount arm boots a real `createGguiServer` on an
    // ephemeral port per suite — allow it time on cold CI runners.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
