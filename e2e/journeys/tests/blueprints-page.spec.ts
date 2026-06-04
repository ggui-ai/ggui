/**
 * Blueprints page proof — closes the Slice-1 loop of the console page
 * construction plan (`docs/plans/2026-04-22-console-page-construction.md`
 * §3.1):
 *
 *   1. Boot `ggui serve` against the `manifest-capabilities` fixture
 *      (same fixture the blueprint-viewer spec uses). The fixture
 *      declares `weather-card-fixture` as a blueprint + one local
 *      primitive catalog (`FixtureBrandTag`).
 *   2. Navigate to `/blueprints`. The SPA fetches
 *      `GET /ggui/console/registry` and paints two columns. The SPA
 *      URL was renamed from `/registry` → `/blueprints` in the 5-item
 *      nav consolidation; the server endpoint kept its technical name.
 *   3. Assert the fixture's blueprint + primitive rows are visible
 *      with the locked test contract data-attrs.
 *   4. Click the blueprint row's `preview →` button and verify the
 *      router lands on `/preview/<id>` with the fixture's mount.
 *   5. Network gate — no hosted / AWS / Cognito calls. The catalog
 *      is a local-only read.
 *
 * Lane 1 of the 4-lane taxonomy (browser + spawned CLI, no LLM,
 * blocking every PR). Pairs with `registry/console-registry.test.ts`
 * (Lane 3) which covers the endpoint shape + error paths in isolation.
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
const BLUEPRINT_ID = 'weather-card-fixture';
const BLUEPRINT_NAME = 'Weather Card Fixture';
const PRIMITIVE_NAME = 'FixtureBrandTag';

test.describe.serial(
  'Console blueprints page — list blueprints + primitives + click through',
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

    test('lists manifest-declared blueprints + primitives, click-through lands on /preview/<id>', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      gate = await installNetworkGate(page);
      await handle.signInAsAdmin(page);

      // 1. Navigate to /admin/blueprints. The SPA mounts, fires its
      //    effect, and paints the two columns.
      await page.goto(`${handle.baseUrl}/admin/blueprints`, {
        waitUntil: 'networkidle',
      });

      // 2. Both columns must be rendered — even if empty, the list
      //    container paints the honest empty state. Scoping by the
      //    data-attr that locks the test contract.
      const blueprintList = page.locator(
        '[data-ggui-registry-list="blueprints"]',
      );
      const primitiveList = page.locator(
        '[data-ggui-registry-list="primitives"]',
      );
      await expect(blueprintList).toBeVisible({ timeout: 10_000 });
      await expect(primitiveList).toBeVisible();

      // 3. The fixture declares exactly one blueprint — the weather
      //    card. The row must carry the id attr so tests can match
      //    it without parsing the visible text.
      const blueprintRow = blueprintList.locator(
        `[data-ggui-registry-item="blueprint"][data-ggui-registry-id="${BLUEPRINT_ID}"]`,
      );
      await expect(blueprintRow).toBeVisible();
      await expect(blueprintRow).toContainText(BLUEPRINT_NAME);

      // 4. The fixture declares exactly one primitive — FixtureBrandTag
      //    from the local ./ui/primitives catalog. Primitives are
      //    demoted to a collapsible aside as of Slice 8d (operator
      //    feedback: "primitives are just FYI"), so the row is only
      //    rendered after the toggle expands the aside.
      await primitiveList
        .locator('button[data-ggui-primitives-toggle]')
        .click();
      const primitiveRow = primitiveList.locator(
        `[data-ggui-registry-item="primitive"][data-ggui-registry-name="${PRIMITIVE_NAME}"]`,
      );
      await expect(primitiveRow).toBeVisible();
      await expect(primitiveRow).toContainText(PRIMITIVE_NAME);
      // Local-source primitive — pill renders the tone-draft "local"
      // tag. Substring match keeps the assertion stable across brand
      // copy tweaks.
      await expect(primitiveRow).toContainText('local');

      // 5. Click-through: the blueprint row's preview button
      //    navigates to /preview/<id>. Load-bearing proof that
      //    blueprints → preview navigation is wired correctly AND
      //    that the URL vocabulary is `/preview/` (not the retired
      //    `/b/`).
      await blueprintRow.getByRole('button', { name: /preview/i }).click();
      await page.waitForURL(`**/preview/${BLUEPRINT_ID}`, {
        timeout: 10_000,
      });
      expect(page.url()).toContain(`/preview/${BLUEPRINT_ID}`);

      // 6. The preview page mounts the fixture — same anchor the
      //    blueprint-viewer spec asserts, scoped by data-ggui-blueprint-id
      //    so this spec doesn't regress if other fixtures land.
      const mountCard = page.locator(
        `[data-ggui-render-entry="component"][data-ggui-blueprint-id="${BLUEPRINT_ID}"]`,
      );
      await expect(mountCard).toBeVisible({ timeout: 15_000 });

      // 7. Network gate — the blueprints catalog is a local read.
      //    Browser must not reach hosted / AWS / Cognito hosts.
      expect(gate.attempts).toEqual([]);
    });

    test('filter input narrows both columns to matching rows', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      await handle.signInAsAdmin(page);
      await page.goto(`${handle.baseUrl}/admin/blueprints`, {
        waitUntil: 'networkidle',
      });

      // Type a substring that only matches the blueprint id. The
      // primitive column must be empty (no match); blueprint column
      // must still show the weather card row.
      const filter = page.getByLabel('filter registry entries');
      await filter.fill('weather');

      const blueprintList = page.locator(
        '[data-ggui-registry-list="blueprints"]',
      );
      const primitiveList = page.locator(
        '[data-ggui-registry-list="primitives"]',
      );
      // Expand the primitives aside so the filter outcome is visible
      // (Slice 8d: collapsed-by-default).
      await primitiveList
        .locator('button[data-ggui-primitives-toggle]')
        .click();
      await expect(
        blueprintList.locator(
          `[data-ggui-registry-item="blueprint"][data-ggui-registry-id="${BLUEPRINT_ID}"]`,
        ),
      ).toBeVisible();
      await expect(
        primitiveList.locator('[data-ggui-registry-item="primitive"]'),
      ).toHaveCount(0);
      await expect(primitiveList).toContainText(/no primitives match/i);

      // Clearing the filter restores both columns.
      await filter.fill('');
      await expect(
        primitiveList.locator(
          `[data-ggui-registry-item="primitive"][data-ggui-registry-name="${PRIMITIVE_NAME}"]`,
        ),
      ).toBeVisible();
    });

    test('cached column renders empty-state when no generations recorded yet', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      await handle.signInAsAdmin(page);
      await page.goto(`${handle.baseUrl}/admin/blueprints`, {
        waitUntil: 'networkidle',
      });
      const cached = page.locator('[data-ggui-cached-list]');
      await expect(cached).toBeVisible({ timeout: 10_000 });
      // Fresh server, no render has fired — empty-state copy explains
      // how to populate the cache.
      await expect(cached).toContainText(/no cached generations yet/i);
    });
  },
);
