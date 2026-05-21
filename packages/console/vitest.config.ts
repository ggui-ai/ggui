import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // React-rendering specs run in jsdom; the node specs that
    // collocate next to them (router/server contract tests) tolerate
    // a DOM global they don't use. Keeping one environment avoids a
    // per-file override banner on every spec.
    environment: 'jsdom',
    globals: true,
  },
});
