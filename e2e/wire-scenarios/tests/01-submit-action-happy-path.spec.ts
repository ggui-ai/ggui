/**
 * Scenario 1 — `submit_action` happy path.
 *
 * PIPE-2 wire: button click inside the iframe → `tools/call
 * ggui_runtime_submit_action` via host postMessage relay → server
 * appends `ActionEnvelope` onto the render-keyed pending-events
 * pipe → agent's `ggui_consume` long-poll drains it mid-turn.
 *
 * In this scenario the "agent" is the test runner: render a contract
 * with `actionSpec.save` (from the SHARED_CONTRACT fixture), resolve
 * the render's `resourceUri` via MCP `resources/read` and mount it
 * behind the MCP-Apps host stand-in (the R5 retirement removed the
 * `/r/<shortCode>` renderer-URL surface — `ggui_render`'s wire output
 * carries no URL; the host stand-in plays the relay role claude.ai /
 * the sample frontend play), click the Save button inside the host's
 * iframe, then call `ggui_consume` and assert the action arrived.
 *
 * Gated on `ANTHROPIC_API_KEY` because render triggers component
 * generation.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import { renderKnownContract } from '../fixtures/render-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import {
  MCP_APP_IFRAME_SELECTOR,
  mountRenderResource,
  type McpAppHostHandle,
} from '../fixtures/mcp-app-host.js';
import { SHARED_CONTRACT, SHARED_INTENT } from '../fixtures/shared-contract.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!HAS_KEY)('Scenario 1 — submit_action happy path', () => {
  let handle: BrowserHandle;
  let host: McpAppHostHandle | undefined;
  beforeEach(async () => {
    // Relay OFF: the mcp-app-host wrapper page IS the host party
    // (answers ui/initialize + relays tools/call). A second relay on
    // the outer window would double-deliver every click's
    // submit_action.
    handle = await openBrowser({ relayToolCallsToMcp: false });
  });
  afterEach(async () => {
    await handle.close();
    await host?.close();
    host = undefined;
  });

  test(
    'iframe button click → pipe append → ggui_consume drains the event',
    async () => {
      // 1. Render a canonical "Save button + note slot" contract.
      //    Shared verbatim with scenarios 02 + 03 so the OSS
      //    in-memory blueprint registry's exact-key matcher cache-
      //    hits across them — first scenario to render cold-gens, the
      //    other two cache-hit (sub-second). Saves 2 cold-gens per
      //    run and contains LLM flakiness to one cold path. The
      //    extra `contextSpec.note` slot is contract bloat from 01's
      //    perspective but it's harmless (the button click still
      //    fires `save` exactly the same), and it's load-bearing
      //    for scenario 03's contextSnapshot assertion.
      const ref = await renderKnownContract({
        mcpUrl: MCP_URL,
        intent: SHARED_INTENT,
        seed: 'scenario-1-happy-path',
        contract: SHARED_CONTRACT,
      });

      // 2. Resolve the render's MCP-App resource (spec-canonical mount
      //    handle) and open it behind the host stand-in.
      host = await mountRenderResource({
        mcpUrl: MCP_URL,
        resourceUri: ref.resourceUri,
      });
      const { page } = handle;
      await page.goto(host.url, { waitUntil: 'networkidle' });
      const appFrame = page.frameLocator(MCP_APP_IFRAME_SELECTOR);

      // 3. Click every Save-named button in turn. Robust to LLMs
      //    that wrap the action in a modal — we click the trigger
      //    if present, then click "Save" inside. Multiple matches:
      //    click each until the pipe accepts an event.
      const buttons = appFrame.getByRole('button', { name: /save/i });
      // 90s: cold-gen + fetch(codeUrl) + dynamic import + react paint.
      // Cache is cleared between e2e runs (global-setup wipes
      // GGUI_CODE_CACHE_DIR), so this scenario always exercises the
      // cold path — keeps the LLM honest about cold-gen latency.
      await buttons.first().waitFor({ state: 'visible', timeout: 90_000 });

      // Visible buttons may include a trigger + "Save" (inside modal,
      // hidden until open). Click visible ones one at a time; each
      // click may reveal a new layer. Cap at 3 iterations so a buggy
      // LLM-generated UI doesn't loop.
      for (let i = 0; i < 3; i++) {
        const visible = buttons.filter({ visible: true });
        const count = await visible.count();
        if (count === 0) break;
        // Prefer the simplest label ("Save" exact) if present.
        const exact = visible.filter({ hasText: /^Save$/i });
        const target = (await exact.count()) > 0 ? exact.first() : visible.first();
        await target.click();
        await page.waitForTimeout(300);
      }

      // 4. Drain the pipe.
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
      // Per-event uiContext is captured at gesture time (post-2026-05-14).
      expect(consumed.events[0]?.uiContext).toBeDefined();
      expect(consumed.status).toBe('active');
    },
    // Test budget: waitFor (90s cold-gen mount) + click loop + consume
    // (10s long-poll inside ggui_consume) + headroom. 180s is the
    // smallest budget that doesn't make the inner 90s mount budget +
    // 10s consume long-poll race the test wrapper.
    180_000,
  );
});
