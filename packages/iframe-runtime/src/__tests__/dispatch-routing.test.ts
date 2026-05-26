/**
 * Pattern α / Pattern β routing for `WireConfig.dispatch`.
 *
 * Per MCP-Apps spec §2026-01-26: tools tagged with
 * `_meta.ui.visibility:['app']` are callable by an iframe from the
 * SAME server connection only — cross-server calls are always blocked.
 *
 * PIPE-2 wire-up (2026-05-12):
 *
 *   - **Pattern α** (direct `tools/call`): same-server, app-visible
 *     target tool. Fires ONE postMessage — direct `tools/call` against
 *     the target. No audit, no `ui/update-model-context`, no
 *     `ui/message`. Pipe append is deliberately skipped to avoid the
 *     host-relay-fires-the-tool AND agent-reacts-to-pipe double-
 *     processing pitfall.
 *
 *   - **Pattern β** (submit_action with ui/message fallback): everything
 *     else (cross-server tool, no wired tool, tool not in
 *     `appCallableTools`). Synchronously fires:
 *       (1) `ui/update-model-context` — silent LLM hint.
 *       (2) `tools/call ggui_runtime_submit_action` via the host relay
 *           — awaits the response.
 *     Then asynchronously, on relay response:
 *       (3) On `{ok:true}` (pipe append succeeded) → DONE.
 *       (3') On `{ok:false}` (PIPE_NOT_FOUND, INVALID_ACTION_KIND, or
 *           transport error) → `ui/message` chat-shortcut so the
 *           gesture reaches the agent on its next turn.
 *
 * Tests cover the synchronous fan-out (which envelopes fire when) and
 * the async fallback path (which is triggered by emulating the host's
 * response via window.postMessage with the matching JSON-RPC id).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireDirectToolCall, routeDispatch } from '../runtime.js';

let postMessageSpy: ReturnType<typeof vi.fn>;
let originalPostMessage: typeof window.parent.postMessage;

beforeEach(() => {
  postMessageSpy = vi.fn();
  originalPostMessage = window.parent.postMessage;
  Object.defineProperty(window.parent, 'postMessage', {
    value: postMessageSpy,
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(window.parent, 'postMessage', {
    value: originalPostMessage,
    configurable: true,
    writable: true,
  });
});

describe('fireDirectToolCall (Pattern α helper)', () => {
  it('emits exactly one direct tools/call against the target tool', () => {
    fireDirectToolCall({
      targetToolName: 'gmail_archive',
      data: { id: 'msg_1' },
    });
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const direct = postMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(direct).toMatchObject({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: {
        name: 'gmail_archive',
        arguments: { id: 'msg_1' },
      },
    });
  });

  it('does NOT emit ui/update-model-context, ui/message, or submit_action audit', () => {
    fireDirectToolCall({
      targetToolName: 'gmail_archive',
      data: { id: 'msg_1' },
    });
    const methods = postMessageSpy.mock.calls.map(
      (call) => (call[0] as { method?: unknown }).method,
    );
    expect(methods).not.toContain('ui/update-model-context');
    expect(methods).not.toContain('ui/message');
    // Only the direct tools/call against the target.
    expect(methods).toEqual(['tools/call']);
    const direct = postMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    expect((direct.params as { name?: unknown }).name).toBe('gmail_archive');
  });

  it('falls back to {} when data is null/undefined', () => {
    fireDirectToolCall({
      targetToolName: 'gmail_archive',
      data: undefined,
    });
    const direct = postMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    expect(
      (direct.params as Record<string, unknown>).arguments as unknown,
    ).toEqual({});
  });
});

describe('routeDispatch — Pattern α vs Pattern β', () => {
  it('Pattern α: 1 envelope (direct tools/call only) when actionNextSteps[name] is in appCallableTools', () => {
    routeDispatch({
      actionName: 'archive',
      data: { id: 'msg_1' },
      meta: {
        sessionId: 'sess_1',
        appId: 'app_1',
        actionNextSteps: { archive: 'gmail_archive' },
        appCallableTools: ['gmail_archive', 'ggui_runtime_submit_action'],
      },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const methods = postMessageSpy.mock.calls.map(
      (call) => (call[0] as { method?: unknown }).method,
    );
    expect(methods).toEqual(['tools/call']);
    const direct = postMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    expect((direct.params as Record<string, unknown>).name).toBe(
      'gmail_archive',
    );
  });

  describe('Pattern β (submit_action with ui/message fallback)', () => {
    it('synchronously fires ui/update-model-context FIRST then tools/call submit_action', () => {
      routeDispatch({
        actionName: 'archive',
        data: { id: 'msg_1' },
        meta: {
          sessionId: 'sess_1',
          appId: 'app_1',
          actionNextSteps: { archive: 'gmail_archive' },
          // gmail_archive is NOT app-visible on this server connection.
          appCallableTools: ['ggui_runtime_submit_action'],
        },
        dispatchToolName: 'ggui_runtime_submit_action',
      });
      // Synchronous fan-out: update-model-context then submit_action.
      // ui/message is NOT fired yet — it depends on the relay response.
      const methods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(methods).toEqual(['ui/update-model-context', 'tools/call']);
      const submitCall = postMessageSpy.mock.calls[1][0] as Record<
        string,
        unknown
      >;
      expect(submitCall).toMatchObject({
        jsonrpc: '2.0',
        method: 'tools/call',
        params: {
          name: 'ggui_runtime_submit_action',
          arguments: {
            kind: 'dispatch',
            payload: {
              intent: 'archive',
              actionData: { id: 'msg_1' },
              uiContext: {},
            },
            sessionId: 'sess_1',
            appId: 'app_1',
          },
        },
      });
    });

    it('on relay response {ok:true} → no ui/message fallback', async () => {
      routeDispatch({
        actionName: 'archive',
        data: { id: 'msg_1' },
        meta: {
          sessionId: 'sess_1',
          appId: 'app_1',
          actionNextSteps: { archive: 'gmail_archive' },
          appCallableTools: ['ggui_runtime_submit_action'],
        },
        dispatchToolName: 'ggui_runtime_submit_action',
      });
      // Grab the JSON-RPC id from the synchronous submit_action call so
      // we can post a matching response back.
      const submitEnvelope = postMessageSpy.mock.calls[1][0] as {
        id: number;
      };
      const responseEvent = new MessageEvent('message', {
        data: {
          jsonrpc: '2.0',
          id: submitEnvelope.id,
          result: { structuredContent: { ok: true } },
        },
      });
      window.dispatchEvent(responseEvent);
      // Let the async listener resolve.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const methods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(methods).not.toContain('ui/message');
    });

    it('on relay response {ok:false, code:PIPE_NOT_FOUND} → ui/message fallback fires', async () => {
      routeDispatch({
        actionName: 'archive',
        data: { id: 'msg_1' },
        meta: {
          sessionId: 'sess_1',
          appId: 'app_1',
          actionNextSteps: { archive: 'gmail_archive' },
          appCallableTools: ['ggui_runtime_submit_action'],
        },
        dispatchToolName: 'ggui_runtime_submit_action',
      });
      const submitEnvelope = postMessageSpy.mock.calls[1][0] as {
        id: number;
      };
      const responseEvent = new MessageEvent('message', {
        data: {
          jsonrpc: '2.0',
          id: submitEnvelope.id,
          result: {
            structuredContent: { ok: false, code: 'PIPE_NOT_FOUND' },
          },
        },
      });
      window.dispatchEvent(responseEvent);
      // Wait for the async fallback to fire.
      await new Promise((resolve) => setTimeout(resolve, 0));
      const methods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(methods).toContain('ui/message');
      const uiMessage = postMessageSpy.mock.calls.find(
        (call) => (call[0] as { method?: unknown }).method === 'ui/message',
      )?.[0] as Record<string, unknown>;
      const params = uiMessage.params as Record<string, unknown>;
      expect(params.role).toBe('user');
    });

    it('on relay response with JSON-RPC error → ui/message fallback fires', async () => {
      routeDispatch({
        actionName: 'archive',
        data: { id: 'msg_1' },
        meta: {
          sessionId: 'sess_1',
          appId: 'app_1',
          actionNextSteps: { archive: 'gmail_archive' },
          appCallableTools: ['ggui_runtime_submit_action'],
        },
        dispatchToolName: 'ggui_runtime_submit_action',
      });
      const submitEnvelope = postMessageSpy.mock.calls[1][0] as {
        id: number;
      };
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            jsonrpc: '2.0',
            id: submitEnvelope.id,
            error: { code: -32601, message: 'no relay wired' },
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      const methods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(methods).toContain('ui/message');
    });
  });

  it('Pattern β when actionNextSteps is absent (legacy bootstrap)', () => {
    routeDispatch({
      actionName: 'archive',
      data: { id: 'msg_1' },
      meta: {
        sessionId: 'sess_1',
        appId: 'app_1',
        // actionNextSteps deliberately undefined.
        appCallableTools: ['gmail_archive'],
      },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    const methods = postMessageSpy.mock.calls.map(
      (call) => (call[0] as { method?: unknown }).method,
    );
    expect(methods).toEqual(['ui/update-model-context', 'tools/call']);
  });

  it('Pattern β when the action name is not in actionNextSteps', () => {
    routeDispatch({
      actionName: 'archive',
      data: { id: 'msg_1' },
      meta: {
        sessionId: 'sess_1',
        appId: 'app_1',
        actionNextSteps: { send: 'gmail_send' },
        appCallableTools: ['gmail_send'],
      },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    const methods = postMessageSpy.mock.calls.map(
      (call) => (call[0] as { method?: unknown }).method,
    );
    expect(methods).toEqual(['ui/update-model-context', 'tools/call']);
  });

  it('Pattern β when appCallableTools is absent (legacy bootstrap)', () => {
    routeDispatch({
      actionName: 'archive',
      data: { id: 'msg_1' },
      meta: {
        sessionId: 'sess_1',
        appId: 'app_1',
        actionNextSteps: { archive: 'gmail_archive' },
      },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    const methods = postMessageSpy.mock.calls.map(
      (call) => (call[0] as { method?: unknown }).method,
    );
    expect(methods).toEqual(['ui/update-model-context', 'tools/call']);
  });
});
