/**
 * Config viewer page proof — Phase B Slice 2A of the console plan
 * (`docs/plans/2026-04-22-console-page-construction.md` §4.B.2 cousin).
 *
 * Lane 1 scope:
 *
 *   1. Boot `ggui serve` against the manifest-capabilities fixture.
 *      The harness sets `cwd` to the fixture directory, so the
 *      server's `findGguiJson(process.cwd())` walk lands the fixture's
 *      own `ggui.json`.
 *   2. Navigate to `/config`. The SPA fetches `GET /ggui/console/config`,
 *      finds the manifest, and paints the section rail + first-section
 *      panel.
 *   3. Assert the source card reports loaded + the fixture path.
 *   4. Click each section in the rail and confirm the panel header
 *      updates to the selected field's name.
 *   5. Toggle the "show raw bytes" button and confirm the raw JSON
 *      block appears.
 *   6. TopNav 'config' link from the chat home navigates to /config.
 *   7. Network gate — no hosted / AWS / Cognito browser hits.
 */
import { test, expect } from '@playwright/test';
import {
  attachServeArtifacts,
  DEVTOOL_DIST,
  GGUI_CLI_DIST,
  installNetworkGate,
  spawnGguiServe,
  type GguiServeHandle,
  type NetworkGate,
} from './ggui-serve-harness';
import { existsSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

const TEST_TIMEOUT_MS = 60_000;
const FIXTURE_DIR = resolvePath(__dirname, 'fixtures/manifest-capabilities');

test.describe.serial(
  'Console config viewer — section rail + schema descriptions + raw bytes',
  () => {
    let handle: GguiServeHandle;
    let gate: NetworkGate;

    test.beforeAll(async () => {
      if (!existsSync(GGUI_CLI_DIST)) {
        test.skip(
          true,
          `@ggui-ai/cli dist missing at ${GGUI_CLI_DIST}.`,
        );
        return;
      }
      if (!existsSync(DEVTOOL_DIST)) {
        test.skip(
          true,
          `@ggui-ai/console dist missing at ${DEVTOOL_DIST}.`,
        );
        return;
      }
      handle = await spawnGguiServe({ fixtureDir: FIXTURE_DIR });
    });

    test.afterAll(async () => {
      if (handle) await handle.close();
    });

    test.afterEach(async () => {
      if (handle) await attachServeArtifacts(handle);
    });

    test('loads the fixture manifest, navigates sections, reveals raw bytes', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      gate = await installNetworkGate(page);
      await handle.signInAsAdmin(page);

      await page.goto(`${handle.baseUrl}/admin/config`, {
        waitUntil: 'networkidle',
      });

      // Page root carries the source-state discriminator. Fixture
      // ships a valid ggui.json so this must be `found-valid`.
      const root = page.locator('[data-ggui-config-source]');
      await expect(root).toBeVisible({ timeout: 10_000 });
      await expect(root).toHaveAttribute('data-ggui-config-source', 'found-valid');

      // Section rail has the load-bearing top-level fields. The
      // `theme` section was lifted out into its own /admin/theme page
      // in Slice 2 (drop theme section from Config + cross-links), and
      // the `adapters` section was retired in Bucket B (LOCKED-22,
      // 2026-05-18); everything else still is in the rail.
      const rail = page.locator('[data-ggui-config-active-section]');
      await expect(rail).toBeVisible();
      for (const name of [
        'app',
        'blueprints',
        'primitives',
        'agent',
        'storage',
        'mcpMounts',
      ]) {
        await expect(
          rail.locator(`[data-ggui-config-section="${name}"]`),
        ).toBeVisible();
      }

      // First section is active by default — the rail data-attr
      // tracks it. Schema is alphabetical via Object.keys, so the
      // order matches the schema declaration order; just assert the
      // attribute exists with a non-empty value.
      const initialActive = await rail.getAttribute(
        'data-ggui-config-active-section',
      );
      expect(initialActive).toBeTruthy();

      // Click the `primitives` section in the rail. The active-attr
      // should update + the right-pane panel should show the schema
      // description for primitives (mentions "discovers UI primitives"
      // per the `.describe()` text). Picked as the canary navigation
      // target after the `adapters` section retirement.
      await rail
        .locator('[data-ggui-config-section="primitives"] button')
        .click();
      await expect(rail).toHaveAttribute(
        'data-ggui-config-active-section',
        'primitives',
      );
      // Description paragraph (the .ggui-body inside the panel) —
      // scope tightly so we don't also match the same text inside the
      // raw schema JSON dump below.
      const panel = page.locator(
        '[data-ggui-config-section="primitives"] .ggui-config-panel__head',
      );
      await expect(panel).toBeVisible({ timeout: 5_000 });
      await expect(
        page
          .locator('[data-ggui-config-section="primitives"]')
          .locator('p.ggui-body')
          .first(),
      ).toContainText(/primitives/i);

      // Raw JSON card: hidden by default, reveal on click.
      await expect(page.locator('[data-ggui-config-raw]')).toHaveCount(0);
      await page.getByRole('button', { name: /show raw bytes/i }).click();
      await expect(page.locator('[data-ggui-config-raw]')).toBeVisible();
      // Raw block contains the fixture's app slug.
      await expect(page.locator('[data-ggui-config-raw]')).toContainText(
        'manifest-capabilities-fixture',
      );

      // Network gate — /config is a local read.
      expect(gate.attempts).toEqual([]);
    });

    test('admin rail config link navigates from /admin/status to /admin/config', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      // Pre-Slice-1 this navigated from `/` (chat home) via the
      // user TopNav. The chat home + user TopNav were retired; the
      // proof now exercises the admin rail under `/admin/status`.
      await handle.signInAsAdmin(page);
      await page.goto(`${handle.baseUrl}/admin/status`, {
        waitUntil: 'networkidle',
      });
      await page
        .getByRole('navigation', { name: /admin sections/i })
        .getByRole('button', { name: /^config$/ })
        .click();
      await page.waitForURL('**/admin/config', { timeout: 10_000 });
      await expect(
        page.locator('[data-ggui-config-source]'),
      ).toBeVisible({ timeout: 10_000 });
    });
  },
);
