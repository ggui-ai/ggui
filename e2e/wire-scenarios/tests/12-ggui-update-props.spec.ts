/**
 * Scenario 12 — `ggui_update` props propagate to a live iframe.
 *
 * Locks in the live-channel propagation contract: when a renderer
 * iframe is mounted from the per-render MCP-App resource (whose
 * self-contained shell embeds the live trio wsUrl + wsToken +
 * sessionId), a server-side `ggui_update` MUST propagate to the
 * iframe over WS so React re-renders with new props.
 *
 * Setup: render a contract with a `propsSpec.count` numeric prop +
 * initial `props: {count: 0}`. Intent steers the LLM to render
 * `Count: <props.count>` so we can assert by visible text. Resolve the
 * render's `resourceUri` via MCP `resources/read` and mount it in a
 * real browser behind the minimal MCP-Apps host stand-in
 * (fixtures/mcp-app-host.ts). Wait for initial `Count: 0`. Call
 * `ggui_update` with `props: {count: 42}`. Assert `Count: 42` becomes
 * visible inside the iframe.
 *
 * ## Obligation remapping (2026-06-11 retired-surfaces port)
 *
 * The propagation assertions (initial `0` paints; after `ggui_update`
 * the DOM shows `42` and drops `0`) are UNCHANGED. What moved is the
 * mount surface: the spec used to open the render's `/r/<shortCode>`
 * URL — retired by R5, and `ggui_render`'s wire output carries no
 * `url`. The spec-canonical mount handle is the `resourceUri`
 * (`ui://ggui/render/...`) on the render's structuredContent, resolved
 * via `resources/read` and framed by a host party — here the minimal
 * MCP-Apps host stand-in (same pattern as scenario 07). The
 * self-contained resource shell embeds the same live trio the retired
 * bootstrap carried, so WS `props_update` delivery is unchanged.
 *
 * Parametric over the model-provider axis. See provider-matrix.ts.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { callTool } from '../fixtures/mcp-client.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import {
  MCP_APP_IFRAME_SELECTOR,
  mountRenderResource,
  type McpAppHostHandle,
} from '../fixtures/mcp-app-host.js';
import { renderKnownContract } from '../fixtures/render-contract.js';
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
        'initial props render; ggui_update with new props triggers re-render',
        async () => {
          // 1. Render a contract with propsSpec.count + initial count=0.
          //    `ggui_render` blocks until cold-gen completes (codeReady).
          const ref = await renderKnownContract({
            mcpUrl: MCP_URL,
            intent: PROPS_INTENT,
            seed: `scenario-12-props-update-${provider.name}`,
            contract: PROPS_CONTRACT,
            props: { count: 0 },
          });

          // 2. Resolve + mount the per-render resource behind the
          //    MCP-Apps host stand-in.
          const { page } = handle;
          host = await mountRenderResource({
            mcpUrl: MCP_URL,
            resourceUri: ref.resourceUri,
          });
          await page.goto(host.url, { waitUntil: 'networkidle' });
          const appFrame = page.frameLocator(MCP_APP_IFRAME_SELECTOR);
          const bodyText = async () => await appFrame.locator('body').innerText();

          // 3. Wait for initial render. Cold-gen already completed
          //    inside ggui_render; this budget covers the mount cascade
          //    (resource shell + runtime fetch + dynamic import + react
          //    paint) — 90s is tail-insurance, matching scenario 07.
          await expect
            .poll(bodyText, { timeout: 90_000, interval: 500 })
            .toMatch(/count/i);
          await expect
            .poll(bodyText, { timeout: 5_000, interval: 200 })
            .toMatch(/\b0\b/);

          // Brief pause so the post-mount fire-and-forget WS subscribe
          // can settle before we fire ggui_update — without this, the
          // server-side fan-out can race ahead of the iframe's subscribe-
          // ack and drop the frame (live-only, no replay buffer).
          await new Promise((r) => setTimeout(r, 500));

          // 4. Call ggui_update with new props.
          await callTool(MCP_URL, 'ggui_update', {
            sessionId: ref.sessionId,
            kind: 'replace',
            props: { count: 42 },
          });

          // 5. Assert the iframe re-renders with the new count.
          await expect
            .poll(bodyText, { timeout: 5_000, interval: 200 })
            .toMatch(/\b42\b/);
          await expect
            .poll(bodyText, { timeout: 2_000, interval: 200 })
            .not.toMatch(/\b0\b/);
        },
        // The render call itself blocks on cold-gen (formerly outside
        // the old spec's paint-poll budget; observed typical ~2-3s) —
        // the 240s ceiling covers gen + mount + the update round-trip
        // across all three providers as tail-insurance for model
        // variance, not the expected duration.
        240_000,
      );
    },
  );
}
