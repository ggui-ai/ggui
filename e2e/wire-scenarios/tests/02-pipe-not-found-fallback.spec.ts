/**
 * Scenario 2 — `PIPE_NOT_FOUND` fall-through to `ui/message`.
 *
 * When `ggui_runtime_submit_action` fires for a renderId whose
 * pipe is closed/missing (render closed, never opened), the
 * server returns `{ok:false, code:'PIPE_NOT_FOUND'}` in
 * structuredContent. The iframe-runtime's `classifySubmitActionResponse`
 * reads `ok === false` → returns `'fallback'` → runtime posts a
 * `ui/message` envelope to the parent so the gesture reaches the
 * agent on the next chat turn.
 *
 * Test choreography:
 *   1. Render a contract (pipe opens server-side via markCreated).
 *   2. Open the renderer URL with a postMessage interceptor.
 *   3. Close the render — closes the pipe (markDeleted).
 *   4. Click the now-stale button.
 *   5. Verify a `ui/message` envelope appears on the parent.
 */
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';
import { pushKnownContract } from '../fixtures/push-contract.js';
import { openBrowser, type BrowserHandle } from '../fixtures/browser.js';
import { SHARED_CONTRACT, SHARED_INTENT } from '../fixtures/shared-contract.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;

// SKIPPED post-flatten-render-identity Phase B (2026-05-27): this
// scenario depended on the `ggui_close` tool to invalidate the pipe
// server-side, then asserted that the next submit_action falls through
// to the `ui/message` inline carrier (PIPE_NOT_FOUND classifier). Phase
// B retired `ggui_close` entirely: renders now decay via TTL only and
// there is no public/admin force-expire affordance to substitute. The
// alternative — waiting out DEFAULT_RENDER_TTL_MS in-test — is too long
// for an e2e budget, and reframing as a transport-disconnect simulation
// would not exercise the same server-side `markDeleted` → PIPE_NOT_FOUND
// path the scenario is named for.
//
// TODO: un-skip once one of:
//   (a) a test-only `ggui_ops_force_expire_render` admin tool ships, or
//   (b) the scenario is reframed against transport-level disconnect
//       (would prove a different code path — not PIPE_NOT_FOUND).
// See: oss/packages/mcp-server-handlers/src/renders/ for where a
// force-expire admin handler would land alongside the existing TTL-decay
// machinery.
describe.skip('Scenario 2 — PIPE_NOT_FOUND fallback (blocked: ggui_close retired Phase B; no force-expire affordance)', () => {
  let handle: BrowserHandle;
  beforeEach(async () => {
    handle = await openBrowser();
  });
  afterEach(async () => {
    await handle.close();
  });

  test(
    'post-pop click falls through to ui/message postMessage',
    async () => {
      const ref = await pushKnownContract({
        mcpUrl: MCP_URL,
        intent: SHARED_INTENT,
        seed: 'scenario-2-fallback',
        contract: SHARED_CONTRACT,
      });

      const { page } = handle;

      // Install a postMessage interceptor BEFORE navigation so we
      // capture the iframe's outbound envelopes.
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
      // 90s: cold-gen + fetch(codeUrl) + dynamic import + react paint
      // (cache cleared between runs via GGUI_CODE_CACHE_DIR).
      await buttons.first().waitFor({ state: 'visible', timeout: 90_000 });

      // Close the render — closes the pipe. Iframe is still
      // mounted in the DOM; its next dispatch hits a missing pipe.
      const closeResult = unwrapStructured<{ success: boolean }>(
        await callTool(MCP_URL, 'ggui_close', { renderId: ref.renderId }),
      );
      expect(closeResult.success).toBe(true);

      // Click. Robust to LLMs that wrap the action in a modal —
      // click the trigger then the inner Save. Up to 3 layers.
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

      // Wait briefly for the async submit_action round trip + fall-
      // through. The renderer posts ui/message to its parent.
      await page.waitForTimeout(1500);

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

      // Post-2026-05-14 — the iframe-runtime's degraded path stamps
      // `_meta.ggui.userAction.kind: 'inline'` on the ui/message
      // envelope so ggui-aware SDKs can route it through their tool-
      // result loop. The action payload + uiContext travel inline so
      // the agent can react WITHOUT calling ggui_consume for this
      // render (the pipe is gone).
      const first = uiMessageEnvelopes[0] as {
        params?: {
          _meta?: {
            ggui?: {
              userAction?: {
                kind?: string;
                renderId?: string;
                actionId?: string;
                submittedAt?: string;
                intent?: string;
                payload?: { actionData?: unknown; uiContext?: unknown };
              };
            };
          };
        };
      };
      const userAction = first.params?._meta?.ggui?.userAction;
      expect(userAction).toBeDefined();
      expect(userAction?.kind).toBe('inline');
      expect(userAction?.renderId).toBe(ref.renderId);
      expect(typeof userAction?.submittedAt).toBe('string');
      expect(typeof userAction?.intent).toBe('string');
      expect(userAction?.payload).toBeDefined();
      // payload.actionData MUST be present (key exists) — explicit null
      // is the no-payload gesture. payload.uiContext MUST be a JSON
      // object (`{}` when the contract has no contextSpec).
      expect('actionData' in (userAction?.payload ?? {})).toBe(true);
      expect(
        typeof userAction?.payload?.uiContext === 'object' &&
          userAction?.payload?.uiContext !== null,
      ).toBe(true);
    },
    // Test budget: waitFor (90s cold-gen) + pop round-trip + click +
    // postMessage delivery. 180s gives slack so the test wrapper
    // doesn't race the inner 90s mount budget.
    180_000,
  );
});
