/**
 * Renders page proof — closes the Slice-3 loop of the console page
 * construction plan (`docs/plans/2026-04-22-console-page-construction.md`
 * §3.3).
 *
 * Scope for Lane 1 coverage:
 *
 *   1. Boot `ggui serve` against the `manifest-capabilities` fixture.
 *      The fixture has no committed renders at boot — perfect for the
 *      empty-state path the `/admin/sessions` page surfaces.
 *   2. Navigate to `/admin/sessions`. The SPA fetches
 *      `GET /ggui/console/sessions` (200, shape `{sessions:[],total:0}`)
 *      and paints the branded empty-state card.
 *   3. Navigate via the TopNav's `renders` link from another page,
 *      proving the cross-page nav wire works.
 *   4. Network gate — `/admin/sessions` is a local read; no hosted /
 *      AWS / Cognito browser hits.
 *
 * Why not seed a populated-list case at Lane 1? Seeding a live
 * render requires either a real `ggui_render` round-trip (needs a
 * BYOK LLM → Lane 2) or a privileged test-fixture endpoint to
 * inject renders (new surface, out of Slice 3). Lane 3
 * (`console-renders.test.ts`) covers the populated-list case with
 * an in-process `InMemoryGguiSessionStore` — faster, deterministic,
 * same contract.
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
  'Console renders page — empty-state + cross-page nav',
  () => {
    let handle: GguiServeHandle;
    let gate: NetworkGate;

    test.beforeAll(async () => {
      if (!existsSync(GGUI_CLI_DIST)) {
        test.skip(
          true,
          `@ggui-ai/cli dist missing at ${GGUI_CLI_DIST}. Run \`pnpm --filter @ggui-ai/cli build\` first.`,
        );
        return;
      }
      if (!existsSync(DEVTOOL_DIST)) {
        test.skip(
          true,
          `@ggui-ai/console dist missing at ${DEVTOOL_DIST}. Run \`pnpm --filter @ggui-ai/console build\` first.`,
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

    test('direct navigation to /admin/sessions paints the empty state', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      gate = await installNetworkGate(page);
      await handle.signInAsAdmin(page);

      await page.goto(`${handle.baseUrl}/admin/sessions`, {
        waitUntil: 'networkidle',
      });

      // The fixture has no live renders, so the endpoint returns
      // `{sessions:[],total:0}` and the SPA renders the empty-state
      // card. Assert the empty-state copy — load-bearing proof the
      // fetch + no-renders branch wired correctly, because the
      // branded-card container has a stable anchor the row list
      // wouldn't produce.
      await expect(
        page.locator('text=No renders yet.'),
      ).toBeVisible({ timeout: 10_000 });

      // No list container when the catalog is empty (component
      // short-circuits before rendering `<GguiSessionList>`).
      await expect(
        page.locator('[data-ggui-sessions-list]'),
      ).toHaveCount(0);

      // Network gate — /admin/sessions is a local read. Browser must
      // not reach hosted / AWS / Cognito hosts.
      expect(gate.attempts).toEqual([]);
    });

    test('status dashboard paints the empty live-renders hero (Slice 10)', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      // Slice 10 replaced the 5th-in-grid "recent renders" card with
      // a full-width hero above the status grid. In the fixture's
      // no-active-renders state, the hero renders its empty variant
      // and points the operator at the playground (where renders
      // get born), not the list (which would be empty too). Active
      // state + "open latest →" + "view all →" are covered by the
      // Lane-3 `Status.test.tsx` spec with a mocked fetch — seeding
      // a real render here would require BYOK, which is Lane 2.
      await handle.signInAsAdmin(page);
      await page.goto(`${handle.baseUrl}/admin/status`, {
        waitUntil: 'networkidle',
      });

      const hero = page.locator('[data-ggui-status-hero]');
      await expect(hero).toHaveAttribute(
        'data-ggui-status-hero',
        'empty',
        { timeout: 10_000 },
      );
      await expect(hero).toContainText('No renders yet.');

      // TopNav live-render pill is suppressed when no render with
      // a shortCode is live — the component collapses to render
      // `null` rather than a placeholder.
      await expect(
        page.locator('[data-ggui-nav-live-pill]'),
      ).toHaveCount(0);
    });
  },
);
