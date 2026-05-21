/**
 * Blueprint browser-mount proof — closes the gap between
 * `ggui_render_blueprint` (tool-level render) and what an operator
 * actually sees on the OSS browser surface.
 *
 * Flow:
 *
 *   1. Boot `ggui serve` against `fixtures/manifest-capabilities/`
 *      (same fixture the search/render wire tests use). The fixture
 *      declares `weather-card-fixture` via
 *      `ggui.json#blueprints.include → ggui.ui.json` + colocates a
 *      TSX source with a distinctive DOM marker.
 *   2. Mint a pair token — needed for the MCP-side search assertion
 *      to confirm the blueprint is discoverable through the same
 *      channel an agent would use before navigating to the viewer.
 *   3. Search via `ggui_search_blueprints` to prove the merge path
 *      surfaces the manifest blueprint. Narrow assertion so a future
 *      scoring / ordering change doesn't make this spec brittle.
 *   4. Navigate the browser to `/preview/weather-card-fixture`. The
 *      SPA fetches `GET /ggui/console/blueprint/:id`, receives the
 *      inline compiled bundle, and hands it to `StackItemRenderer`
 *      (the same primitive `/s/<shortCode>` uses).
 *   5. Assert the mount card + the fixture's distinctive DOM
 *      markers (`Weather Card Fixture` heading + the
 *      `data-testid="weather-card-fixture"` anchor the TSX defines).
 *      Seeing those markers in the live DOM is the load-bearing
 *      proof that: render resolved → server endpoint returned the
 *      code → client fetched → `StackItemRenderer` compiled + mounted.
 *
 * Lane 1 of the 4-lane taxonomy (browser + spawned CLI, no LLM,
 * blocking every PR, <60s). Reuses `installNetworkGate` so any
 * regression that points the browser at a hosted / AWS / Cognito host
 * fails the spec — blueprint rendering is a local-only operation.
 */
import { test, expect } from '@playwright/test';
import {
  attachServeArtifacts,
  DEVTOOL_DIST,
  GGUI_CLI_DIST,
  installNetworkGate,
  mcpCallAs,
  mintPairToken,
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

test.describe.serial(
  'Blueprint browser mount — register → search → render → mount',
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

    test('search discovers blueprint, /preview/<id> mounts compiled code with the fixture\'s distinctive DOM', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      gate = await installNetworkGate(page);

      // 1. Mint a pair token for the MCP-side search assertion.
      const { token } = await mintPairToken(handle, 'blueprint-viewer-spec');
      expect(token.length).toBeGreaterThan(0);

      // 2. Search first — proves the blueprint is discoverable on the
      //    tool surface an agent would use. Narrow assertion: the
      //    merged result must contain the manifest id.
      const searchEnv = await mcpCallAs(handle.baseUrl, token, 'tools/call', {
        name: 'ggui_search_blueprints',
        arguments: { query: 'weather' },
      });
      expect(searchEnv.error).toBeUndefined();
      const searchResult = searchEnv.result as {
        structuredContent?: {
          results?: Array<{ id: string; name: string }>;
        };
      };
      const hit = (searchResult.structuredContent?.results ?? []).find(
        (r) => r.id === BLUEPRINT_ID,
      );
      expect(
        hit,
        'Search must surface the manifest blueprint before the browser mount proof — if this fails, the merge path regressed.',
      ).toBeDefined();
      expect(hit?.name).toBe(BLUEPRINT_NAME);

      // 3. Navigate to the blueprint viewer. The SPA's effect fires
      //    on mount → `GET /ggui/console/blueprint/:id` → the
      //    handler resolves the bundle via `LocalUiRegistry` →
      //    component mounts.
      await page.goto(`${handle.baseUrl}/preview/${BLUEPRINT_ID}`, {
        waitUntil: 'networkidle',
      });

      // 4. Mount card paints with the canonical data-ggui-* anchors
      //    (same contract SessionViewer's StackSurface uses). Scoping
      //    by `data-ggui-blueprint-id` so a future multi-blueprint
      //    route can land without churning this spec.
      const mountCard = page.locator(
        `[data-ggui-stack-entry="component"][data-ggui-blueprint-id="${BLUEPRINT_ID}"]`,
      );
      await expect(mountCard).toBeVisible({ timeout: 15_000 });
      await expect(mountCard).toHaveAttribute('data-ggui-code-ready', 'true');

      // 5. The React-component renderer produces a `ggui-rcr-*`
      //    scoped class on the outer host node — same signal the
      //    session viewer's stack cards emit. Waiting for it is the
      //    visible proof that compile → import → mount actually
      //    completed in the browser.
      const rcrScope = mountCard.locator('[class^="ggui-rcr-"]');
      await expect(rcrScope).toBeVisible({ timeout: 15_000 });

      // 6. The distinctive DOM markers the TSX source defines.
      //    Seeing these in the live DOM is the load-bearing mount
      //    proof — if the compile / mount path had silently fallen
      //    back to an error panel or mounted an empty component,
      //    neither marker would appear.
      const fixtureAnchor = rcrScope.locator(
        'article[data-testid="weather-card-fixture"]',
      );
      await expect(fixtureAnchor).toBeVisible({ timeout: 15_000 });
      await expect(fixtureAnchor.locator('h1')).toHaveText(BLUEPRINT_NAME);
      await expect(fixtureAnchor.locator('p')).toContainText(
        'manifest-registered blueprint',
      );

      // 7. Network gate — blueprint rendering is a local-only op.
      //    No hosted / AWS / Cognito call from the browser.
      expect(gate.attempts).toEqual([]);
    });

    test('unknown blueprint id shows the not-found card', async ({ page }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      // Negative half. A mistyped id in the URL must land the SPA
      // on the "blueprint not found" panel, not a white screen and
      // not the mount card. Same-origin fetch returns 404; the
      // router state moves to `not-found`.
      await page.goto(`${handle.baseUrl}/preview/does-not-exist`, {
        waitUntil: 'networkidle',
      });
      await expect(
        page.locator('text=Blueprint not found'),
      ).toBeVisible({ timeout: 10_000 });
      // No mount card for an unknown id.
      await expect(
        page.locator('[data-ggui-stack-entry="component"]'),
      ).toHaveCount(0);
    });

    test('retired /b/<id> shape falls through to the 404 card (pre-launch no-backcompat)', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      // The `/b/<id>` vocabulary was renamed to `/preview/<id>` on
      // 2026-04-22. Per the pre-launch no-backcompat rule, the old
      // path is retired — no alias, no 301. The SPA's router lands
      // `/b/<id>` on the NotFound page (the "Nothing lives here."
      // panel the App renders for unknown kinds).
      await page.goto(`${handle.baseUrl}/b/${BLUEPRINT_ID}`, {
        waitUntil: 'networkidle',
      });
      await expect(
        page.locator('text=Nothing lives here.'),
      ).toBeVisible({ timeout: 10_000 });
      // No mount card — if the route had silently aliased, the
      // fixture's mount would still paint.
      await expect(
        page.locator('[data-ggui-stack-entry="component"]'),
      ).toHaveCount(0);
    });
  },
);
