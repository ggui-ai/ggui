/**
 * Scenario 10 — queued userAction nudge when no consumer is registered.
 *
 * Post-2026-05-14 pivot: the pipe is the single source of truth. When
 * the user fires a gesture inside the iframe but no `ggui_consume`
 * long-poll is registered for the targeted stack item, the server
 * returns `{ok:true, consumerPresent:false}` on submit_action and the
 * iframe-runtime emits a `ui/message` IMMEDIATELY with
 * `_meta.ggui.userAction.kind: 'queued'` so the agent's next turn
 * calls `ggui_consume({stackItemId})` to drain.
 *
 * No 10s timer. No rescue drain. The pipe holds the data; the nudge
 * tells the agent where to look.
 *
 * Test choreography:
 *   1. Push a contract with `actionSpec.save` (no agent listening).
 *   2. Open the renderer URL with a postMessage interceptor.
 *   3. Click the Save button. (No `ggui_consume` long-poll runs in
 *      this test, so the server reports `consumerPresent: false`.)
 *   4. Assert that a `ui/message` arrives with
 *      `_meta.ggui.userAction.kind === 'queued'`,
 *      `nextStep.tool === 'ggui_consume'`, and the right stackItemId.
 *   5. Drain via `ggui_consume` and assert the event carries
 *      `intent: 'save'` + per-event `actionData` + `uiContext`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import { pushKnownContract } from '../fixtures/push-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import { SHARED_CONTRACT, SHARED_INTENT } from '../fixtures/shared-contract.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!HAS_KEY)('Scenario 10 — no-consumer queued nudge', () => {
  let handle: BrowserHandle;
  beforeEach(async () => {
    handle = await openBrowser();
  });
  afterEach(async () => {
    await handle.close();
  });

  test(
    'click without active consumer → queued userAction nudge → consume drains the event',
    async () => {
      const ref = await pushKnownContract({
        mcpUrl: MCP_URL,
        intent: SHARED_INTENT,
        seed: 'scenario-10-no-consumer-nudge',
        contract: SHARED_CONTRACT,
      });

      const { page } = handle;

      // postMessage interceptor BEFORE navigation so we capture every
      // outbound iframe envelope including the queued-userAction nudge.
      await page.addInitScript(() => {
        (
          window as unknown as { __capturedMessages: unknown[] }
        ).__capturedMessages = [];
        window.addEventListener('message', (ev) => {
          (
            window as unknown as { __capturedMessages: unknown[] }
          ).__capturedMessages.push(ev.data);
        });
      });

      await page.goto(ref.url, { waitUntil: 'networkidle' });
      const buttons = page.getByRole('button', { name: /save/i });
      await buttons.first().waitFor({ state: 'visible', timeout: 90_000 });

      // Click ONCE — submit_action succeeds, pipe entry stored
      // server-side. No `ggui_consume` long-poll is running from this
      // test, so the server reports `consumerPresent: false`.
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

      // Small wait for the async submit_action round-trip + queued
      // userAction emit. No 10s timer involved — the nudge fires
      // immediately on the consumerPresent:false response.
      await page.waitForTimeout(2_000);

      const messages = await page.evaluate(() => {
        return (
          window as unknown as { __capturedMessages: unknown[] }
        ).__capturedMessages;
      });

      const uiMessageEnvelopes = (
        messages as Array<Record<string, unknown>>
      ).filter(
        (m) => m !== null && typeof m === 'object' && m.method === 'ui/message',
      );
      expect(uiMessageEnvelopes.length).toBeGreaterThan(0);

      const first = uiMessageEnvelopes[0] as {
        params?: {
          _meta?: {
            ggui?: {
              userAction?: {
                kind?: string;
                stackItemId?: string;
                intent?: string;
                actionId?: string;
                submittedAt?: string;
                nextStep?: {
                  tool?: string;
                  args?: { stackItemId?: string };
                };
              };
            };
          };
        };
      };
      const userAction = first.params?._meta?.ggui?.userAction;
      expect(userAction).toBeDefined();
      expect(userAction?.kind).toBe('queued');
      expect(userAction?.stackItemId).toBe(ref.stackItemId);
      expect(typeof userAction?.intent).toBe('string');
      expect(typeof userAction?.submittedAt).toBe('string');
      expect(userAction?.nextStep?.tool).toBe('ggui_consume');
      expect(userAction?.nextStep?.args?.stackItemId).toBe(ref.stackItemId);

      // Drain via ggui_consume — the event IS on the pipe (the queued
      // nudge is a wake-up signal, not a fallback delivery). Each
      // event now carries per-event `actionData` + `uiContext`.
      const consumed = unwrapStructured<{
        events: ReadonlyArray<{
          intent?: string;
          actionData?: unknown;
          uiContext?: Record<string, unknown>;
        }>;
        status: string;
      }>(
        await callTool(MCP_URL, 'ggui_consume', {
          stackItemId: ref.stackItemId,
          timeout: 5,
        }),
      );
      expect(consumed.events.length).toBeGreaterThan(0);
      expect(consumed.events[0]?.intent).toBe('save');
      expect(consumed.events[0]?.uiContext).toBeDefined();
    },
    // 90s mount + 2s queued-nudge wait + consume + headroom.
    180_000,
  );
});
