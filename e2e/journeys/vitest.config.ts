/**
 * Vitest config — Lane 3 contract tests for ggui OSS MCP fixtures.
 *
 * This package is Playwright-first. This config exists strictly to
 * run the Lane-3 contract tests that live alongside the MCP fixtures
 * in `tests/fixtures/mcps/**` (per stateful-MCP strategy §4.3:
 * "Pure vitest, no browser, no full server boot").
 *
 * Scope is deliberately narrow — Playwright `*.spec.ts` files are
 * excluded so the two test runners don't collide. Future fixture
 * contract tests (notes, contacts) will match the same glob without
 * needing config changes.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Matches both the per-fixture Lane-3 contract tests AND the
    // top-level release-readiness checks (e.g. the transitive-package
    // drift check at `tests/tarball-transitive-packages.test.ts`).
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    reporters: ['default'],
  },
});
