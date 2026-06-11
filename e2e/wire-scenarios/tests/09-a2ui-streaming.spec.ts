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
 *   1. `render` returns with a render committed whose MCP-App resource
 *      is immediately mountable (provisional placeholder or final).
 *   2. Iframe shows visible content within a few seconds of mounting
 *      (the A2UI provisional surface) — the user is NEVER staring at
 *      a blank screen during cold-gen.
 *   3. The final component eventually replaces the provisional surface
 *      (within the 90s cold-gen budget).
 *
 * Drive path (post-R5): the render's `resourceUri` is resolved via MCP
 * `resources/read` and mounted behind the MCP-Apps host stand-in
 * (fixtures/mcp-app-host.ts) — the retired `/r/<shortCode>` renderer
 * URL no longer serves the iframe. The visibility probes go through
 * the host's app iframe and read the resource document's BODY text:
 * the runtime mounts the surface in the document body, not inside the
 * shell's `#ggui-root` anchor (verified empirically 2026-06-11 —
 * `#ggui-root` stays empty while the rendered UI paints), so the
 * pre-port `#ggui-root.innerText` probe would read '' forever.
 *
 * Parametric over the model-provider axis. See provider-matrix.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { renderKnownContract } from '../fixtures/render-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import {
  MCP_APP_IFRAME_SELECTOR,
  mountRenderResource,
  type McpAppHostHandle,
} from '../fixtures/mcp-app-host.js';
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
      let host: McpAppHostHandle | undefined;
      beforeEach(async () => {
        // Relay OFF: the mcp-app-host wrapper page IS the host party.
        handle = await openBrowser({ relayToolCallsToMcp: false });
      });
      afterEach(async () => {
        await handle.close();
        await host?.close();
        host = undefined;
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

          host = await mountRenderResource({
            mcpUrl: MCP_URL,
            resourceUri: ref.resourceUri,
          });
          const { page } = handle;
          await page.goto(host.url, { waitUntil: 'networkidle' });
          const appFrame = page.frameLocator(MCP_APP_IFRAME_SELECTOR);

          // The provisional A2UI surface should mount within a few
          // seconds of page load — far before cold-gen completes. We
          // assert that SOME visible content exists in the iframe long
          // before the final "Submit" button could possibly land.
          // Probe the resource document's body — the runtime mounts
          // the surface there, not inside `#ggui-root` (see header).
          const body = appFrame.locator('body');
          await body.waitFor({ state: 'attached', timeout: 5_000 });

          let sawProvisionalContent = false;
          const provisionalDeadline = Date.now() + 8_000;
          while (Date.now() < provisionalDeadline) {
            const text = await body.innerText().catch(() => '');
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
          const submit = appFrame.getByRole('button', { name: /submit/i });
          await submit.first().waitFor({ state: 'visible', timeout: 90_000 });
        },
        120_000,
      );
    },
  );
}
