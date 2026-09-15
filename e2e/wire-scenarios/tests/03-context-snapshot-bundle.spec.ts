/**
 * Scenario 3 — per-event `uiContext` captured at gesture time.
 *
 * Post-2026-05-14 the pipe is the single source of truth: each
 * pipe entry carries `{intent, actionData, uiContext, …}` so the
 * agent sees WHAT the user did AND WHAT THEY WERE LOOKING AT
 * atomically. The pre-2026-05-14 top-level `contextSnapshot` on the
 * consume output was retired; `uiContext` now lives per-event.
 *
 * Drive path (post-R5): the render's `resourceUri` is resolved via
 * MCP `resources/read` and mounted behind the MCP-Apps host stand-in
 * (fixtures/mcp-app-host.ts) — the retired `/r/<shortCode>` renderer
 * URL no longer serves the iframe. Assertions are unchanged.
 *
 * Parametric over the model-provider axis — one row per ggui-default-
 * <provider> instance. Each row skips cleanly when its key is missing;
 * `GGUI_E2E_REQUIRE_ALL_PROVIDERS=1` flips skip → hard-fail.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { Locator } from 'playwright-core';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import { renderKnownContract } from '../fixtures/render-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import {
  MCP_APP_IFRAME_SELECTOR,
  mountRenderResource,
  type McpAppHostHandle,
} from '../fixtures/mcp-app-host.js';
import { SHARED_CONTRACT, SHARED_INTENT } from '../fixtures/shared-contract.js';
import { PROVIDERS, REQUIRE_ALL, providerSkip } from '../fixtures/provider-matrix.js';

/**
 * `save` is a REPEATABLE action, and both halves of that are declared by
 * the fixture rather than assumed here: it is absent from ui-gen's
 * `TERMINAL_WORDS` (`submit|confirm|approve|schedule|reserve|book|pay|
 * checkout|purchase|order`), and {@link SHARED_INTENT} says the click
 * "fires the save action immediately". So its control MUST survive its
 * own gesture.
 *
 * Why this assertion exists at all (ggui#1108, Exp 005): over-guarding
 * has **no lexical signal**. Terminality does — the action's name — which
 * is why `universal.terminal_action_unguarded` can be keyword-shaped.
 * Nothing in generated source distinguishes a correctly guarded terminal
 * control from a wrongly guarded repeatable one; the only distinguishing
 * act is interacting a SECOND time, which is what the click loop below
 * already does. That made the loop an accidental detector. This makes it
 * an explicit one.
 *
 * It buys LEGIBILITY, not coverage: the loop already fails when the
 * control is guarded, but it fails as a 30s `element is not enabled`
 * timeout that cost a bisect to interpret. A detector whose output has to
 * be decoded gets misread by whoever meets it first.
 *
 * Scope, deliberately: ONE spec asserts this, not three. 01 and 10 share
 * the fixture and keep the bare loop, so this claim has a single owner.
 * And it sees exactly one shape — a single-action Save contract — so a
 * model that over-guards only book/pay-shaped repeatables passes here
 * clean. This is a regression tripwire, never the acceptance criterion
 * for a prompt change.
 */
async function expectSaveStillRepeatable(controls: Locator): Promise<void> {
  const visible = controls.filter({ visible: true });
  expect(
    await visible.count(),
    'repeatable action `save` lost its control after firing — no visible /save/i ' +
      'control remains. `save` is not in ui-gen TERMINAL_WORDS and SHARED_INTENT ' +
      'declares the click fires it immediately, so the control must survive its ' +
      'own gesture.',
  ).toBeGreaterThan(0);

  const first = visible.first();
  const label = (await first.innerText({ timeout: 1_000 }).catch(() => '')).trim();
  expect(
    await first.isEnabled({ timeout: 1_000 }),
    `repeatable action \`save\` was guarded after firing — the control now reads ` +
      `"${label}" and is disabled. \`save\` is not in ui-gen TERMINAL_WORDS and ` +
      `SHARED_INTENT declares the click fires it immediately, so it must still ` +
      `accept a second interaction.`,
  ).toBe(true);
}

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
      let host: McpAppHostHandle | undefined;
      beforeEach(async () => {
        handle = await openBrowser();
      });
      afterEach(async () => {
        await handle.close();
        await host?.close();
        host = undefined;
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

          host = await mountRenderResource({
            mcpUrl: MCP_URL,
            resourceUri: ref.resourceUri,
          });
          const { page } = handle;
          await page.goto(host.url, { waitUntil: 'networkidle' });
          const appFrame = page.frameLocator(MCP_APP_IFRAME_SELECTOR);

          const buttons = appFrame.getByRole('button', { name: /save/i });
          // Cold-gen first time the cache is fresh (observed typical
          // ~2-3s; the 90s ceiling is tail-insurance for model
          // variance); warm hit (sub-second) once the canonical
          // contract is in the OSS in-memory blueprint registry (01/02
          // render the same shape so this often gets a cache hit when
          // they ran first in the same run).
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
            // First gesture only: the loop's remaining iterations are the
            // drive path, not the assertion.
            if (i === 0) await expectSaveStillRepeatable(buttons);
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
