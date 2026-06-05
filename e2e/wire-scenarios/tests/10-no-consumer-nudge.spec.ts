/**
 * Scenario 10 — pure-doorbell user-action when no consumer is registered.
 *
 * The pipe is the single source of truth. When the user fires a gesture
 * inside the iframe but no `ggui_consume` long-poll is registered for the
 * targeted render, the server returns `{ok:true, consumerPresent:false}`
 * on submit_action and the iframe-runtime emits a `ui/message`
 * IMMEDIATELY. That message is a PURE DOORBELL: its TEXT carries the
 * imperative `ggui_consume({sessionId})` directive (every host forwards it
 * verbatim), and its structured mirror lives on
 * `content[0]._meta["ai.ggui/userAction"]` with `kind: 'user-action'` —
 * a pointer ONLY, never the action payload. The agent's next turn calls
 * `ggui_consume({sessionId})` to drain the gesture that's already on the
 * pipe.
 *
 * No 10s timer. No rescue drain. No inline payload. The pipe holds the
 * data; the doorbell tells the agent where to look. Pointer-only ⇒ the
 * agent retrieves the gesture EXCLUSIVELY via `ggui_consume`, so the loop
 * is exactly-once by construction.
 *
 * Test choreography:
 *   1. GguiSession a contract with `actionSpec.save` (no agent listening).
 *   2. Open the renderer URL with a postMessage interceptor.
 *   3. Click the Save button. (No `ggui_consume` long-poll runs in
 *      this test, so the server reports `consumerPresent: false`.)
 *   4. Assert a `ui/message` arrives whose TEXT carries the
 *      `ggui_consume` directive + `<ggui_directive kind="user-action">`,
 *      and whose `content[0]._meta["ai.ggui/userAction"]` is a pure
 *      pointer (`kind === 'user-action'`, `nextStep.tool === 'ggui_consume'`,
 *      correct sessionId, NO action payload).
 *   5. Drain via `ggui_consume` and assert the event carries
 *      `intent: 'save'` + per-event `actionData` + `uiContext`.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import { renderKnownContract } from '../fixtures/render-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import { SHARED_CONTRACT, SHARED_INTENT } from '../fixtures/shared-contract.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;
const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!HAS_KEY)(
  'Scenario 10 — no-consumer pure-doorbell user-action',
  () => {
    let handle: BrowserHandle;
    beforeEach(async () => {
      handle = await openBrowser();
    });
    afterEach(async () => {
      await handle.close();
    });

    test(
      'click without active consumer → pure-doorbell user-action → consume drains the event',
      async () => {
        const ref = await renderKnownContract({
          mcpUrl: MCP_URL,
          intent: SHARED_INTENT,
          seed: 'scenario-10-no-consumer-nudge',
          contract: SHARED_CONTRACT,
        });

        const { page } = handle;

        // postMessage interceptor BEFORE navigation so we capture every
        // outbound iframe envelope including the doorbell user-action.
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

        // Small wait for the async submit_action round-trip + doorbell
        // emit. No 10s timer involved — the doorbell fires immediately on
        // the consumerPresent:false response.
        await page.waitForTimeout(2_000);

        const messages = await page.evaluate(() => {
          return (
            window as unknown as { __capturedMessages: unknown[] }
          ).__capturedMessages;
        });

        const uiMessageEnvelopes = (
          messages as Array<Record<string, unknown>>
        ).filter(
          (m) =>
            m !== null && typeof m === 'object' && m.method === 'ui/message',
        );
        expect(uiMessageEnvelopes.length).toBeGreaterThan(0);

        // Spec-canonical shape: the structured pointer AND the directive
        // text both live on the content block — NOT on params._meta.
        const first = uiMessageEnvelopes[0] as {
          params?: {
            role?: string;
            content?: Array<{
              type?: string;
              text?: string;
              _meta?: {
                'ai.ggui/userAction'?: {
                  kind?: string;
                  sessionId?: string;
                  intent?: string;
                  actionId?: string;
                  submittedAt?: string;
                  payload?: unknown;
                  nextStep?: {
                    tool?: string;
                    args?: { sessionId?: string };
                  };
                };
              };
            }>;
          };
        };
        expect(first.params?.role).toBe('user');

        const content = first.params?.content ?? [];
        expect(content.length).toBeGreaterThan(0);
        const block = content[0];
        expect(block?.type).toBe('text');

        // THE DIRECTIVE LIVES IN THE TEXT — every host (including
        // `_meta`-agnostic ones) forwards this to the model verbatim. It
        // MUST carry the imperative ggui_consume instruction on its own
        // and name ONLY the render pointer (never the action) so it can't
        // tempt a pre-consume action.
        const text = block?.text ?? '';
        expect(text).toContain('ggui_consume');
        expect(text).toContain('<ggui_directive kind="user-action">');
        expect(text).toContain(ref.sessionId);

        // Structured mirror: pure pointer on
        // content[0]._meta["ai.ggui/userAction"].
        const userAction = block?._meta?.['ai.ggui/userAction'];
        expect(userAction).toBeDefined();
        expect(userAction?.kind).toBe('user-action');
        expect(userAction?.sessionId).toBe(ref.sessionId);
        expect(typeof userAction?.intent).toBe('string');
        expect(typeof userAction?.submittedAt).toBe('string');
        expect(userAction?.nextStep?.tool).toBe('ggui_consume');
        expect(userAction?.nextStep?.args?.sessionId).toBe(ref.sessionId);
        // PURE DOORBELL: NO action payload travels on the doorbell — the
        // gesture stays solely on the pipe (exactly-once by construction).
        expect(userAction?.payload).toBeUndefined();

        // Drain via ggui_consume — the event IS on the pipe (the doorbell
        // is a wake-up signal, not a fallback delivery). Each event
        // carries per-event `actionData` + `uiContext`.
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
        expect(consumed.events[0]?.uiContext).toBeDefined();
      },
      // 90s mount + 2s doorbell wait + consume + headroom.
      180_000,
    );
  },
);
