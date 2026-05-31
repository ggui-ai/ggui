/**
 * Playwright config — ggui OSS E2E (Phase 5 per
 * `docs/plans/2026-04-21-oss-split-e2e-phases.md`).
 *
 * Scope lock: the OSS journey project ONLY. No sandbox/platform
 * webServer, no global-setup Docker container, no hosted auth
 * fixtures. The reason this config exists separately from the hosted
 * `e2e/playwright.config.ts` is the whole POINT of the package split
 * — OSS proof must not load hosted-only dependencies at config-eval
 * time. If a future slice needs a shared base, extract by subtraction
 * from here, not by re-coupling to the hosted root.
 *
 * Project name `journeys-ggui-oss` is preserved verbatim so docs,
 * Makefile targets, and CI invocations referencing it keep resolving.
 * The project was `opt-in` in the hosted config; here it's the default
 * (and only) project — running `playwright test` with no `--project`
 * flag picks it up.
 */
import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import { PACKAGES_ROOT, envFilePath } from './tests/workspace-paths';

// Load the OSS-subtree-root `.env.local` so specs inherit BYOK keys
// without a per-package env file. `.env.local` is gitignored — each dev
// keeps their own; CI injects the keys via GitHub Actions secrets
// instead. A missing file is fine: dotenv no-ops and every honest spec
// skips cleanly when its gating env var is absent.
loadEnv({ path: envFilePath() });

export default defineConfig({
  testDir: './tests',
  // Playwright picks up `*.spec.ts` only. The `*.test.ts` siblings
  // belong to vitest (MCP fixture contract tests under
  // `tests/fixtures/mcps/**/*.test.ts`) — not Playwright. Without
  // this gate, Playwright tries to load them and blows up on the
  // vitest CJS/ESM surface.
  testMatch: '**/*.spec.ts',
  // Test artifacts + the HTML report land under `<workspace>/e2e-results/`
  // — `PACKAGES_ROOT` is `oss/` in the monorepo and the repo root in the
  // OSS standalone repo, so both layouts get a sane, git-ignored output
  // tree (`.gitignore` ignores `e2e-results/` unanchored at any depth).
  // Absolute paths so the location is independent of Playwright's cwd.
  outputDir: resolve(PACKAGES_ROOT, 'e2e-results', 'ggui-oss'),

  // Retry budget per spec — live-LLM flake is real; a couple of retries
  // absorb it without masking genuine regressions.
  retries: 2,
  // 3 workers locally so independent journey specs parallelize across test
  // files; CI keeps 1 (deterministic ordering + bounded runner resource).
  workers: process.env.CI ? 1 : 3,
  timeout: 300_000, // 5 min — covers live-BYOK + tarball install

  forbidOnly: !!process.env.CI,

  reporter: [
    ['list'],
    [
      'html',
      {
        // Nested under the same git-ignored `e2e-results/` tree as
        // `outputDir` so the HTML report stays untracked in both
        // layouts (`/playwright-report/` is root-anchored in
        // `.gitignore`, so a sibling `playwright-report/` would be
        // committed in the OSS standalone repo).
        outputFolder: resolve(PACKAGES_ROOT, 'e2e-results', 'ggui-oss-report'),
        open: 'never',
      },
    ],
  ],

  use: {
    // With `retries: 0`, `on-first-retry` would never fire and the
    // trace viewer would never see a failed run. `retain-on-failure`
    // keeps the trace for failures only — matches plan §12.1's
    // intent ("always-on for Phase 5 browser specs") while keeping
    // the artifact footprint bounded.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // Plan §12.1 marks video as optional for Phase 5, retain-on-
    // failure for Phase 6. Aligning here cuts ~5-10MB per passing
    // run while preserving the diagnostic signal on failure.
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'journeys-ggui-oss',
      testDir: './tests',
      use: { ...devices['Desktop Chrome'] },
      // Includes CLI spawn + Verdaccio tarball install + live BYOK
      // generation in the opt-in BYOK path. The harness handles its
      // own timeouts internally; this is the project-level cap.
      timeout: 300_000,
      // Parallel across test files — specs that share fixed ports (e.g.
      // `pair-flow.spec.ts`, `npx-bootstrap.spec.ts`) are scheduled by
      // Playwright as separate files, so they land on different workers.
      fullyParallel: true,
    },
  ],
});
