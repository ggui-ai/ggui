/**
 * Scenario 12 — `ggui_update` props propagate to a live iframe (B6).
 *
 * Locks in the B4 fix: when a renderer iframe is mounted via
 * `bootSelfContained` AND the bootstrap carries the live trio
 * (wsUrl + token + renderId), a server-side `ggui_update` MUST
 * propagate to the iframe over WS so React re-renders with new props.
 *
 * Setup: render a contract with a `propsSpec.count` numeric prop +
 * initial `props: {count: 0}`. Intent steers the LLM to render
 * `Count: <props.count>` so we can assert by visible text. Open the
 * `/r/<shortCode>` URL. Wait for initial `Count: 0`. Call
 * `ggui_update` with `props: {count: 42}`. Assert `Count: 42` becomes
 * visible.
 *
 * Parametric over the model-provider axis. See provider-matrix.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { callTool } from '../fixtures/mcp-client.js';
import { renderKnownContract } from '../fixtures/render-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import { PROVIDERS, REQUIRE_ALL, providerSkip } from '../fixtures/provider-matrix.js';

const PROPS_INTENT =
  "render a single text element displaying the current count value in the format 'Count: <value>'. read the value from props.count. no buttons, no inputs, no animations — just the text. when props.count changes, the text MUST update to reflect the new value.";

const PROPS_CONTRACT = {
  propsSpec: {
    properties: {
      count: {
        schema: { type: 'integer' },
        required: true,
      },
    },
  },
} as const;

for (const provider of PROVIDERS) {
  const hasKey = !!process.env[provider.apiKey];
  describe.skipIf(providerSkip(provider))(
    `Scenario 12 [${provider.name}] — ggui_update props propagate to iframe`,
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
        'initial props render; ggui_update with new props triggers re-render',
        async () => {
          // 1. Render a contract with propsSpec.count + initial count=0.
          const ref = await renderKnownContract({
            mcpUrl: MCP_URL,
            intent: PROPS_INTENT,
            seed: `scenario-12-props-update-${provider.name}`,
            contract: PROPS_CONTRACT,
            props: { count: 0 },
          });

          const { page } = handle;
          await page.goto(ref.url, { waitUntil: 'networkidle' });

          // 3. Wait for initial render. 90s budget mirrors scenario 01 —
          //    cold-gen + fetch(codeUrl) + dynamic import + react paint.
          await expect
            .poll(async () => await page.locator('body').innerText(), {
              timeout: 90_000,
              interval: 500,
            })
            .toMatch(/count/i);
          await expect
            .poll(async () => await page.locator('body').innerText(), {
              timeout: 5_000,
              interval: 200,
            })
            .toMatch(/\b0\b/);

          // Brief pause so the post-mount fire-and-forget WS subscribe
          // can settle before we fire ggui_update — without this, the
          // server-side fan-out can race ahead of the iframe's subscribe-
          // ack and drop the frame (live-only, no replay buffer).
          await new Promise((r) => setTimeout(r, 500));

          // 4. Call ggui_update with new props.
          await callTool(MCP_URL, 'ggui_update', {
            renderId: ref.renderId,
            kind: 'replace',
            props: { count: 42 },
          });

          // 5. Assert the iframe re-renders with the new count.
          await expect
            .poll(async () => await page.locator('body').innerText(), {
              timeout: 5_000,
              interval: 200,
            })
            .toMatch(/\b42\b/);
          await expect
            .poll(async () => await page.locator('body').innerText(), {
              timeout: 2_000,
              interval: 200,
            })
            .not.toMatch(/\b0\b/);
        },
        120_000,
      );
    },
  );
}
