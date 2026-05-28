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
 *       (2) `tools/call ggui_runtime_submit_action` — routed through
 *           the spec-canonical `app.callServerTool` API. Awaits the
 *           response.
 *     Then asynchronously, on relay response:
 *       (3) On `{ok:true}` (pipe append succeeded) → DONE.
 *       (3') On `{ok:false}` (PIPE_NOT_FOUND, INVALID_ACTION_KIND, or
 *           transport error) → `ui/message` chat-shortcut so the
 *           gesture reaches the agent on its next turn.
 *
 * Post-Phase-1.19b.3 (2026-05-28): outbound `tools/call` from
 * `dispatchWiredAction` flows through `app.callServerTool` on the
 * module-level App handle (`setCurrentApp`). This suite injects a
 * `MockTransport`-bound App via `setCurrentApp` so the `submit_action`
 * envelope round-trips through the spec-canonical API and the relay
 * response is delivered via `transport.queueResponse('tools/call', …)`
 * instead of a faked `MessageEvent`. Notifications
 * (`ui/update-model-context`, `ui/message`) and the Pattern α direct
 * `tools/call` (`fireDirectToolCall`) still flow through raw
 * `window.parent.postMessage`, so they remain asserted via the
 * `postMessageSpy`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@modelcontextprotocol/ext-apps';
import {
  __resetAppForTest,
  fireDirectToolCall,
  routeDispatch,
  setCurrentApp,
} from '../runtime.js';
import { buildBootHarness, tick } from './boot-helpers.js';
import type { MockTransport } from './mock-transport.js';

let postMessageSpy: ReturnType<typeof vi.fn>;
let originalPostMessage: typeof window.parent.postMessage;
let transport: MockTransport;
let app: App;

beforeEach(async () => {
  postMessageSpy = vi.fn();
  originalPostMessage = window.parent.postMessage;
  Object.defineProperty(window.parent, 'postMessage', {
    value: postMessageSpy,
    configurable: true,
    writable: true,
  });

  const harness = buildBootHarness();
  transport = harness.transport;
  app = harness.app;
  await app.connect(transport);
  setCurrentApp(app);
});

afterEach(() => {
  Object.defineProperty(window.parent, 'postMessage', {
    value: originalPostMessage,
    configurable: true,
    writable: true,
  });
  __resetAppForTest();
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
        renderId: 'render_1',
        appId: 'app_1',
        actionNextSteps: { archive: 'gmail_archive' },
        appCallableTools: ['gmail_archive', 'ggui_runtime_submit_action'],
      },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    // Pattern α flows through fireDirectToolCall → postToParent → raw
    // postMessage. Nothing hits the App transport.
    expect(postMessageSpy).toHaveBeenCalledTimes(1);
    const methods = postMessageSpy.mock.calls.map(
      (call) => (call[0] as { method?: unknown }).method,
    );
    expect(methods).toEqual(['tools/call']);
    const direct = postMessageSpy.mock.calls[0][0] as Record<string, unknown>;
    expect((direct.params as Record<string, unknown>).name).toBe(
      'gmail_archive',
    );
    // Pattern α does NOT call submit_action — transport.sent stays empty.
    const toolsCallsOnTransport = transport.sent.filter(
      (msg) => (msg as { method?: unknown }).method === 'tools/call',
    );
    expect(toolsCallsOnTransport).toHaveLength(0);
  });

  describe('Pattern β (submit_action with ui/message fallback)', () => {
    it('synchronously fires ui/update-model-context on raw postMessage and tools/call submit_action through App transport', async () => {
      routeDispatch({
        actionName: 'archive',
        data: { id: 'msg_1' },
        meta: {
          renderId: 'render_1',
          appId: 'app_1',
          actionNextSteps: { archive: 'gmail_archive' },
          // gmail_archive is NOT app-visible on this server connection.
          appCallableTools: ['ggui_runtime_submit_action'],
        },
        dispatchToolName: 'ggui_runtime_submit_action',
      });

      // (1) ui/update-model-context — notification, fires synchronously
      // on raw postMessage.
      const postMessageMethods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(postMessageMethods).toEqual(['ui/update-model-context']);

      // (2) submit_action — fires through app.callServerTool, lands on
      // transport.sent. The send is async (queueMicrotask round-trip),
      // so drain the microtask queue before asserting.
      await tick();
      const toolsCallsOnTransport = transport.sent.filter(
        (msg) => (msg as { method?: unknown }).method === 'tools/call',
      );
      expect(toolsCallsOnTransport).toHaveLength(1);
      const submitCall = toolsCallsOnTransport[0] as Record<string, unknown>;
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
            renderId: 'render_1',
            appId: 'app_1',
          },
        },
      });
    });

    it('on relay response {ok:true} → no ui/message fallback', async () => {
      transport.queueResponse('tools/call', {
        result: { structuredContent: { ok: true } },
      });

      routeDispatch({
        actionName: 'archive',
        data: { id: 'msg_1' },
        meta: {
          renderId: 'render_1',
          appId: 'app_1',
          actionNextSteps: { archive: 'gmail_archive' },
          appCallableTools: ['ggui_runtime_submit_action'],
        },
        dispatchToolName: 'ggui_runtime_submit_action',
      });

      // Let App round-trip the request + response.
      await tick();
      await tick();

      const postMessageMethods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(postMessageMethods).not.toContain('ui/message');
    });

    it('on relay response {ok:false, code:PIPE_NOT_FOUND} → ui/message fallback fires', async () => {
      transport.queueResponse('tools/call', {
        result: {
          structuredContent: { ok: false, code: 'PIPE_NOT_FOUND' },
        },
      });

      routeDispatch({
        actionName: 'archive',
        data: { id: 'msg_1' },
        meta: {
          renderId: 'render_1',
          appId: 'app_1',
          actionNextSteps: { archive: 'gmail_archive' },
          appCallableTools: ['ggui_runtime_submit_action'],
        },
        dispatchToolName: 'ggui_runtime_submit_action',
      });

      // Wait for the async fallback to fire.
      await tick();
      await tick();

      const postMessageMethods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(postMessageMethods).toContain('ui/message');
      const uiMessage = postMessageSpy.mock.calls.find(
        (call) => (call[0] as { method?: unknown }).method === 'ui/message',
      )?.[0] as Record<string, unknown>;
      const params = uiMessage.params as Record<string, unknown>;
      expect(params.role).toBe('user');
    });

    it('on relay response with JSON-RPC error → ui/message fallback fires', async () => {
      transport.queueResponse('tools/call', {
        error: { code: -32601, message: 'no relay wired' },
      });

      routeDispatch({
        actionName: 'archive',
        data: { id: 'msg_1' },
        meta: {
          renderId: 'render_1',
          appId: 'app_1',
          actionNextSteps: { archive: 'gmail_archive' },
          appCallableTools: ['ggui_runtime_submit_action'],
        },
        dispatchToolName: 'ggui_runtime_submit_action',
      });

      await tick();
      await tick();

      const postMessageMethods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(postMessageMethods).toContain('ui/message');
    });
  });

  it('Pattern β when actionNextSteps is absent (legacy bootstrap)', async () => {
    routeDispatch({
      actionName: 'archive',
      data: { id: 'msg_1' },
      meta: {
        renderId: 'render_1',
        appId: 'app_1',
        // actionNextSteps deliberately undefined.
        appCallableTools: ['gmail_archive'],
      },
      dispatchToolName: 'ggui_runtime_submit_action',
    });

    // ui/update-model-context fires synchronously on raw postMessage.
    const postMessageMethods = postMessageSpy.mock.calls.map(
      (call) => (call[0] as { method?: unknown }).method,
    );
    expect(postMessageMethods).toEqual(['ui/update-model-context']);

    // submit_action fires through the App transport.
    await tick();
    const toolsCallsOnTransport = transport.sent.filter(
      (msg) => (msg as { method?: unknown }).method === 'tools/call',
    );
    expect(toolsCallsOnTransport).toHaveLength(1);
  });

  it('Pattern β when the action name is not in actionNextSteps', async () => {
    routeDispatch({
      actionName: 'archive',
      data: { id: 'msg_1' },
      meta: {
        renderId: 'render_1',
        appId: 'app_1',
        actionNextSteps: { send: 'gmail_send' },
        appCallableTools: ['gmail_send'],
      },
      dispatchToolName: 'ggui_runtime_submit_action',
    });

    const postMessageMethods = postMessageSpy.mock.calls.map(
      (call) => (call[0] as { method?: unknown }).method,
    );
    expect(postMessageMethods).toEqual(['ui/update-model-context']);

    await tick();
    const toolsCallsOnTransport = transport.sent.filter(
      (msg) => (msg as { method?: unknown }).method === 'tools/call',
    );
    expect(toolsCallsOnTransport).toHaveLength(1);
  });

  it('Pattern β when appCallableTools is absent (legacy bootstrap)', async () => {
    routeDispatch({
      actionName: 'archive',
      data: { id: 'msg_1' },
      meta: {
        renderId: 'render_1',
        appId: 'app_1',
        actionNextSteps: { archive: 'gmail_archive' },
      },
      dispatchToolName: 'ggui_runtime_submit_action',
    });

    const postMessageMethods = postMessageSpy.mock.calls.map(
      (call) => (call[0] as { method?: unknown }).method,
    );
    expect(postMessageMethods).toEqual(['ui/update-model-context']);

    await tick();
    const toolsCallsOnTransport = transport.sent.filter(
      (msg) => (msg as { method?: unknown }).method === 'tools/call',
    );
    expect(toolsCallsOnTransport).toHaveLength(1);
  });
});
