import { defineConfig } from 'vitest/config';

// `tsc` builds this package's tests into dist/ beside its sources. vitest 3's
// default `exclude` skipped dist/; vitest 4 narrowed it to node_modules and
// .git, so without an explicit include every test ran twice — once from src,
// once from its stale compiled copy.
export default defineConfig({
  test: {
    setupFiles: ['../../test-support/no-ambient-aws.mjs'],
    include: ['src/**/*.test.ts'],
  },
});
