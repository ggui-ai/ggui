/**
 * Scenario 2 — `PIPE_NOT_FOUND` is terminal (no inline fallback, no doorbell).
 *
 * When `ggui_runtime_submit_action` fires a `kind:'dispatch'` envelope
 * for a sessionId whose pending-events pipe was never opened (or has been
 * decayed/closed), the server's `pendingEventConsumer.append` throws
 * `PendingPipeNotFoundError` → the handler returns
 * `{ok:false, code:'PIPE_NOT_FOUND'}` in `structuredContent`.
 *
 * Under the collapsed single-`user-action` design, PIPE_NOT_FOUND is a
 * TERMINAL outcome: the gesture could NOT be enqueued, so there is
 * nothing on any pipe to point a doorbell at. The iframe-runtime emits
 * NO `ui/message` (and never inlines the action payload). Contrast with
 * scenario 10, where the append SUCCEEDS (`{ok:true,
 * consumerPresent:false}`) and the iframe DOES fire the pure-pointer
 * doorbell so a fresh agent turn drains the queued gesture via
 * `ggui_consume`.
 *
 * This is a deterministic server-contract check: no LLM, no browser, no
 * cold-gen. It calls the relay-visible `ggui_runtime_submit_action`
 * directly against `/mcp` (the same route the host relays the iframe's
 * `tools/call` through) with a sessionId that was never minted, and pins
 * the `{ok:false, code:'PIPE_NOT_FOUND'}` envelope the iframe-runtime
 * branches on.
 *
 * Rewritten 2026-05-29 (#294): the prior scenario depended on the
 * retired `ggui_close` tool to invalidate a live pipe and asserted the
 * old inline-carrier `ui/message` fallback — both gone with the
 * `queued`/`inline` collapse. The PIPE_NOT_FOUND contract itself is
 * unchanged, so this scenario now pins it directly at the server
 * boundary instead.
 */
import { describe, expect, test } from 'vitest';
import { callTool, unwrapStructured } from '../fixtures/mcp-client.js';

const GGUI_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const MCP_URL = `http://localhost:${GGUI_PORT}/mcp`;

describe('Scenario 2 — PIPE_NOT_FOUND is terminal (no fallback, no doorbell)', () => {
  test(
    'dispatch to a never-minted sessionId → {ok:false, code:PIPE_NOT_FOUND}',
    async () => {
      // A sessionId the server has never `markCreated` for. The handler's
      // `pendingEventConsumer.append` throws `PendingPipeNotFoundError`,
      // which surfaces as `{ok:false, code:'PIPE_NOT_FOUND'}`.
      const missingSessionId = `rnd_pipe_not_found_${Date.now().toString(36)}`;

      const result = unwrapStructured<{
        ok: boolean;
        code?: string;
        message?: string;
        consumerPresent?: boolean;
      }>(
        await callTool(MCP_URL, 'ggui_runtime_submit_action', {
          kind: 'dispatch',
          payload: {
            intent: 'save',
            // `actionData` key MUST be present; `null` is the bare-click
            // gesture. `uiContext` MUST be a JSON object (`{}` = no
            // contextSpec). See `isGguiSubmitActionInput` (dispatch arm).
            actionData: null,
            uiContext: {},
          },
          sessionId: missingSessionId,
          appId: 'app_scenario_2',
          actionId: 'deadbeef',
          firedAt: new Date().toISOString(),
        }),
      );

      // Append failed → terminal PIPE_NOT_FOUND. No append happened, so
      // `consumerPresent` is absent (it only rides a successful append).
      expect(result.ok).toBe(false);
      expect(result.code).toBe('PIPE_NOT_FOUND');
      expect(result.consumerPresent).toBeUndefined();
    },
    30_000,
  );
});
