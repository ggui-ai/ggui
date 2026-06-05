/**
 * Scenario 3 — per-event `uiContext` captured at gesture time.
 *
 * Post-2026-05-14 the pipe is the single source of truth: each
 * pipe entry carries `{intent, actionData, uiContext, …}` so the
 * agent sees WHAT the user did AND WHAT THEY WERE LOOKING AT
 * atomically. The pre-2026-05-14 top-level `contextSnapshot` on the
 * consume output was retired; `uiContext` now lives per-event.
 *
 * Parametric over the model-provider axis — one row per ggui-default-
 * <provider> instance. Each row skips cleanly when its key is missing;
 * `GGUI_E2E_REQUIRE_ALL_PROVIDERS=1` flips skip → hard-fail.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import { renderKnownContract } from '../fixtures/render-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import { SHARED_CONTRACT, SHARED_INTENT } from '../fixtures/shared-contract.js';
import { PROVIDERS, REQUIRE_ALL, providerSkip } from '../fixtures/provider-matrix.js';

for (const provider of PROVIDERS) {
  const hasKey = !!process.env[provider.apiKey];
  describe.skipIf(providerSkip(provider))(
    `Scenario 3 [${provider.name}] — per-event uiContext on consume`,
    () => {
      if (!hasKey) {
        // REQUIRE_ALL + missing key → emit a single failing test so CI
        // surfaces the missing credential as a real failure (not a skip).
        test(`${provider.apiKey} missing (REQUIRE_ALL_PROVIDERS=${REQUIRE_ALL ? '1' : '0'})`, () => {
          throw new Error(
            `GGUI_E2E_REQUIRE_ALL_PROVIDERS=1 but ${provider.apiKey} is not set — ` +
              `the ${provider.name} row cannot run.`,
          );
        });
        return;
      }
      const MCP_URL = provider.mcpUrl;
      let handle: BrowserHandle;
      beforeEach(async () => {
        handle = await openBrowser();
      });
      afterEach(async () => {
        await handle.close();
      });

      test(
        'consume returns events + per-event uiContext',
        async () => {
          const ref = await renderKnownContract({
            mcpUrl: MCP_URL,
            intent: SHARED_INTENT,
            seed: `scenario-3-context-snapshot-${provider.name}`,
            contract: SHARED_CONTRACT,
          });

          const { page } = handle;
          await page.goto(ref.url, { waitUntil: 'networkidle' });

          const buttons = page.getByRole('button', { name: /save/i });
          // 90s: cold-gen first time the cache is fresh; warm hit (sub-
          // second) once the canonical contract is in the OSS in-memory
          // blueprint registry (01/02 render the same shape so this often
          // gets a cache hit when they ran first in the same run).
          await buttons.first().waitFor({ state: 'visible', timeout: 90_000 });
          for (let i = 0; i < 3; i++) {
            const visible = buttons.filter({ visible: true });
            const count = await visible.count();
            if (count === 0) break;
            const exact = visible.filter({ hasText: /^Save$/i });
            const target =
              (await exact.count()) > 0 ? exact.first() : visible.first();
            await target.click();
            await page.waitForTimeout(300);
          }

          const consumed = unwrapStructured<{
            events: ReadonlyArray<{
              intent?: string;
              actionData?: unknown;
              uiContext?: Record<string, unknown>;
            }>;
            status: string;
          }>(
            await callTool(MCP_URL, 'ggui_consume', {
              sessionId: ref.sessionId,
              timeout: 5,
            }),
          );

          expect(consumed.events.length).toBeGreaterThan(0);
          expect(consumed.events[0]?.intent).toBe('save');
          // Per-event uiContext is captured at gesture time on the
          // iframe. The contract declares a `note` slot; the iframe's
          // default value is `''` and the user didn't change it, so we
          // expect the snapshot to include `note: ''` (or be {} when
          // the slot wasn't registered yet — both are honest reads of
          // local state).
          expect(consumed.events[0]?.uiContext).toBeDefined();
        },
        // Test budget: 90s waitFor (cold-gen) + sync_context + consume +
        // headroom. 180s matches scenarios 01+02; if 01 ran first and
        // warmed the registry, this scenario completes in seconds.
        180_000,
      );
    },
  );
}
