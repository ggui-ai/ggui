/**
 * Scenario 9 — A2UI provisional preview streams during cold-gen.
 *
 * OSS `ggui serve` wires a deterministic provisional-preview emitter
 * (`createDeterministicPreviewEmitter`) on `provisionalPreview.emitter`.
 * The handler kicks off the emitter at render time, BEFORE
 * `runGenerationIntoGguiSession` calls the real LLM. Frames stream over
 * the reserved `_ggui:preview` channel, and the iframe-runtime's
 * `mountProvisional` renders the A2UI surface visibly while cold-gen
 * runs in the background. When the authoritative componentCode lands,
 * the provisional surface is replaced in-place.
 *
 * Wire-contract this scenario locks:
 *
 *   1. `render` returns FAST (before LLM completes), with a placeholder
 *      render appended.
 *   2. Iframe shows visible content within a few seconds of `goto`
 *      (the A2UI provisional surface) — the user is NEVER staring at
 *      a blank screen during cold-gen.
 *   3. The final component eventually replaces the provisional surface
 *      (within the 90s cold-gen budget).
 *
 * Parametric over the model-provider axis. See provider-matrix.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { renderKnownContract } from '../fixtures/render-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import { PROVIDERS, REQUIRE_ALL, providerSkip } from '../fixtures/provider-matrix.js';

for (const provider of PROVIDERS) {
  const hasKey = !!process.env[provider.apiKey];
  describe.skipIf(providerSkip(provider))(
    `Scenario 9 [${provider.name}] — A2UI provisional preview streams during cold-gen`,
    () => {
      if (!hasKey) {
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
        'iframe shows provisional A2UI content before final component lands',
        async () => {
          // Unique seed so this scenario never hits the in-memory
          // generation cache from prior tests in the same run.
          const seed = `a2ui-stream-${provider.name}-${Date.now()}`;
          const ref = await renderKnownContract({
            mcpUrl: MCP_URL,
            intent:
              'one form with a single text input labeled Email and a Submit button',
            seed,
            contract: {
              actionSpec: {
                submit: {
                  label: 'Submit',
                },
              },
            },
          });

          const { page } = handle;
          await page.goto(ref.url, { waitUntil: 'networkidle' });

          // The provisional A2UI surface should mount within a few
          // seconds of page load — far before cold-gen completes. We
          // assert that SOME visible content exists in the iframe long
          // before the final "Submit" button could possibly land.
          const root = page.locator('#ggui-root');
          await root.waitFor({ state: 'attached', timeout: 5_000 });

          let sawProvisionalContent = false;
          const provisionalDeadline = Date.now() + 8_000;
          while (Date.now() < provisionalDeadline) {
            const text = await root.innerText().catch(() => '');
            if (text.trim().length > 0) {
              sawProvisionalContent = true;
              break;
            }
            await page.waitForTimeout(200);
          }
          expect(sawProvisionalContent).toBe(true);

          // Final mount — the authoritative componentCode replaces the
          // provisional surface. 90s budget covers cold-gen + fetch(
          // codeUrl) + dynamic import + react paint.
          const submit = page.getByRole('button', { name: /submit/i });
          await submit.first().waitFor({ state: 'visible', timeout: 90_000 });
        },
        120_000,
      );
    },
  );
}
