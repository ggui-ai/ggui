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

// Load repo-root `.env` so specs inherit BYOK keys + CLI paths without
// needing a per-package `.env.local`. Missing file is fine — every
// honest spec skips cleanly when its gating env var is absent.
loadEnv({ path: resolve(__dirname, '../../../.env') });

export default defineConfig({
  testDir: './tests',
  // Playwright picks up `*.spec.ts` only. The `*.test.ts` siblings
  // belong to vitest (MCP fixture contract tests under
  // `tests/fixtures/mcps/**/*.test.ts`) — not Playwright. Without
  // this gate, Playwright tries to load them and blows up on the
  // vitest CJS/ESM surface.
  testMatch: '**/*.spec.ts',
  outputDir: '../../../e2e-results/ggui-oss',

  // OSS specs are fast (<60s each on the blocking subset). No retries
  // so flakes surface as real signal, not as silenced warnings.
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  timeout: 300_000, // 5 min — covers live-BYOK + tarball install

  forbidOnly: !!process.env.CI,

  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: '../../../playwright-report/ggui-oss',
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
      // Serial — specs share port ranges + temp-CWDs, and the live
      // BYOK spec makes a real Anthropic call that we don't want
      // concurrent with anything else.
      fullyParallel: false,
      retries: 0,
    },
  ],
});
