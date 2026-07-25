import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
// Share the journeys suite's workspace-root resolution — identical topology,
// no reason to duplicate. envFilePath() finds the outermost `.env.local`
// (monorepo) or the nearest one (OSS standalone) so specs inherit the BYOK key.
import { PACKAGES_ROOT, envFilePath } from '../journeys/tests/workspace-paths';

loadEnv({ path: envFilePath() });

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.ts',
  outputDir: resolve(PACKAGES_ROOT, 'e2e-results', 'samples-render'),
  // Fixed host ports (6781/6890) → one booted app at a time host-side. The
  // container cell gives the app its own localhost.
  workers: 1,
  fullyParallel: false,
  retries: 1,
  // Generous: the first test bears the one-time build+publish plus
  // compose+install+boot+LLM. A nightly capstone, not a fast unit gate.
  timeout: 1_500_000,
  forbidOnly: !!process.env['CI'],
  reporter: [
    ['list'],
    [
      'html',
      {
        outputFolder: resolve(PACKAGES_ROOT, 'e2e-results', 'samples-render-report'),
        open: 'never',
      },
    ],
  ],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'samples-render',
      testDir: './tests',
      use: {
        ...devices['Desktop Chrome'],
        // The container cell runs as root (Chromium refuses its sandbox as
        // root) → --no-sandbox; harmless host-side. --disable-dev-shm-usage
        // avoids /dev/shm exhaustion in containers.
        launchOptions: { args: ['--no-sandbox', '--disable-dev-shm-usage'] },
      },
    },
  ],
});
