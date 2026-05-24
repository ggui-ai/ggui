import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for `@ggui-ai/console`.
 *
 * Builds the static SPA into `dist/` (HTML + JS + CSS + assets). The server
 * package (`@ggui-ai/mcp-server`) reads `CONSOLE_DIST_DIR` from the
 * `./server` export and mounts it via `express.static`. Keep this file
 * minimal — scope creep here (route plugins, asset pipelines, dev
 * proxies) is a smell that we're blurring the line between "operator
 * landing page" and a real product surface. See
 * docs/plans/2026-04-20-core-server-console-mvp.md §3.1.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // Vite's default 500 kB raw-size warning doesn't match this
    // project's actual budget — `scripts/check-bundle-size.ts`
    // enforces 400 kB stress / 500 kB hard on GZIPPED size, which
    // is the dimension users feel. Raise to 1 MB raw so Vite stays
    // quiet while the gzip-budget check provides the real safeguard.
    chunkSizeWarningLimit: 1000,
    // Single-file target → report-style gzip budget in
    // scripts/check-bundle-size.ts stays readable. Operators don't
    // need code-splitting for a two-route SPA.
    rollupOptions: {
      output: {
        manualChunks: undefined,
      },
    },
  },
});
