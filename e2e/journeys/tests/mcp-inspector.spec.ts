/**
 * MCP tool inspector page proof — Phase B Slice 1 of the console
 * page construction plan (`docs/plans/2026-04-22-console-page-construction.md`
 * §4.B.1).
 *
 * Lane 1 scope:
 *
 *   1. Boot `ggui serve` against the manifest-capabilities fixture.
 *   2. Navigate to `/tools`. The SPA fetches `GET /ggui/console/mcp/tools`
 *      and renders one expandable card per registered handler. The
 *      SPA path is `/tools` (not `/mcp`) because `/mcp` is the JSON-RPC
 *      transport endpoint; the 5-item nav consolidation also made the
 *      nav label read 'tools' to match the URL.
 *   3. Assert at least the canonical OSS-default tool
 *      `ggui_search_blueprints` shows up with a name + description.
 *   4. Click the row to expand → input + output JSON Schema blocks
 *      become visible. Click again → collapsed.
 *   5. TopNav 'tools' link is reachable from the chat home page.
 *   6. Network gate — the inspector is a local read; no hosted / AWS /
 *      Cognito browser hits.
 *
 * Test invoke (POST → tool call from the browser) is NOT in scope —
 * deferred per plan §4.B.1 pending the same-origin bearer claim
 * design.
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
const KNOWN_TOOL = 'ggui_search_blueprints';

test.describe.serial(
  'Console MCP inspector — list registered tools, expand for schemas',
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

    test('lists registered tools, click row expands input + output schemas', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      gate = await installNetworkGate(page);
      await handle.signInAsAdmin(page);

      // SPA path is `/admin/tools` — `/mcp` is the JSON-RPC transport
      // endpoint owned by the MCP runtime and would shadow the SPA
      // route. The Slice 1 admin-zone refactor moved the operator
      // tools page under `/admin/*`; the JSON endpoint feeding the
      // page (`GET /ggui/console/mcp/tools`) kept its technical name.
      await page.goto(`${handle.baseUrl}/admin/tools`, { waitUntil: 'networkidle' });

      // The list container paints with the locked data-attr. The
      // canonical search tool must be one of the rows.
      const list = page.locator('[data-ggui-mcp-list]');
      await expect(list).toBeVisible({ timeout: 10_000 });

      const knownRow = list.locator(
        `[data-ggui-mcp-tool-name="${KNOWN_TOOL}"]`,
      );
      await expect(knownRow).toBeVisible();
      // Description is non-empty for every default handler — the
      // value is part of the operator-facing contract.
      await expect(knownRow).toContainText(/\w/);
      // Row starts collapsed.
      await expect(knownRow).toHaveAttribute(
        'data-ggui-mcp-tool-expanded',
        'false',
      );

      // Click the toggle button → expand. Targeting the button (not
      // the row container) because after expansion the row's
      // visible center lands on the schema block, which is OUTSIDE
      // the toggle's click target.
      const toggle = knownRow.locator('button').first();
      await toggle.click();
      await expect(knownRow).toHaveAttribute(
        'data-ggui-mcp-tool-expanded',
        'true',
      );
      await expect(
        knownRow.locator('[data-ggui-mcp-schema="input"]'),
      ).toBeVisible();
      await expect(
        knownRow.locator('[data-ggui-mcp-schema="output"]'),
      ).toBeVisible();

      // Click the toggle again → collapsed, schemas detach.
      await toggle.click();
      await expect(knownRow).toHaveAttribute(
        'data-ggui-mcp-tool-expanded',
        'false',
      );
      await expect(
        knownRow.locator('[data-ggui-mcp-schema="input"]'),
      ).toHaveCount(0);

      // Network gate — the inspector is a local read.
      expect(gate.attempts).toEqual([]);
    });

    test('admin rail tools link navigates from /admin/status to /admin/tools', async ({
      page,
    }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      // Cross-page nav wire — operator opens the admin landing
      // (`/admin/status`, default for the admin zone since the Slice 1
      // user-zone retirement) and clicks `tools` in the admin rail.
      // Lands on the inspector with the list painted. Pre-Slice-1 this
      // navigated from `/` (chat home) via the TopNav; that surface
      // was retired so the proof now exercises the AdminShell rail
      // instead.
      await handle.signInAsAdmin(page);
      await page.goto(`${handle.baseUrl}/admin/status`, {
        waitUntil: 'networkidle',
      });
      await page
        .getByRole('navigation', { name: /admin sections/i })
        .getByRole('button', { name: /^tools$/ })
        .click();
      await page.waitForURL('**/admin/tools', { timeout: 10_000 });
      await expect(page.locator('[data-ggui-mcp-list]')).toBeVisible({
        timeout: 10_000,
      });
    });
  },
);
