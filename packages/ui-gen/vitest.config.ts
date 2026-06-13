import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // ui-gen unit tests do real work — esbuild compiles, tsc self-checks,
    // and jsdom render-checks — each ~0.7–2s in isolation. On a cold-cache
    // 2-core CI runner under full-suite (~49-file) concurrency the heaviest
    // paths cross vitest's 5000ms default and time out non-deterministically
    // (a different handful each run). Raise the floor to match the package's
    // genuine work; a real hang still surfaces well within the lane budget.
    // Mirrors the @ggui-ai/ui-visual-tester precedent (which uses 60s).
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
