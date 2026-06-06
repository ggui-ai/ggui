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
 *   - **Pattern β** (submit_action with ui/message doorbell): everything
 *     else (cross-server tool, no wired tool, tool not in
 *     `appCallableTools`). Synchronously fires:
 *       (1) `ui/update-model-context` — silent LLM hint.
 *       (2) `tools/call ggui_runtime_submit_action` — routed through
 *           the spec-canonical `app.callServerTool` API. Awaits the
 *           response.
 *     Then asynchronously, on relay response:
 *       (3) On `{ok:true, consumerPresent:true}` (or `consumerPresent`
 *           absent) → DONE; the agent's active `ggui_consume` long-poll
 *           drains the just-enqueued gesture.
 *       (3') On `{ok:true, consumerPresent:false}` (no consume loop is
 *           listening — e.g. after a page reload) → emit the
 *           `ai.ggui/userAction` PURE DOORBELL on a `ui/message` (RAW
 *           postMessage, bypassing the host's closed-schema parse so the
 *           directive text + content-block `_meta` survive) so a fresh
 *           agent turn calls `ggui_consume({sessionId})` to drain it.
 *           Pointer-only — the gesture stays solely on the pipe.
 *       (3'') On `{ok:false}` / JSON-RPC error → the enqueue FAILED; the
 *           gesture is on no pipe, so NO `ui/message` is emitted (a
 *           doorbell would point at an empty queue). Surfaces a toast
 *           only.
 *
 * Post-Phase-1.19b.3 (2026-05-28): outbound `tools/call` from
 * `dispatchWiredAction` flows through `app.callServerTool` on the
 * module-level App handle (`setCurrentApp`). This suite injects a
 * `MockTransport`-bound App via `setCurrentApp` so the `submit_action`
 * envelope round-trips through the spec-canonical API and the relay
 * response is delivered via `transport.queueResponse('tools/call', …)`
 * instead of a faked `MessageEvent`. `ui/update-model-context` flows
 * through the App method (`app.updateModelContext`) and is asserted on
 * `transport.sent`. The Pattern α direct `tools/call`
 * (`fireDirectToolCall`) and the Pattern β `ui/message` DOORBELL both
 * ride raw `window.parent.postMessage`, so they are asserted via the
 * `postMessageSpy`. The doorbell uses the raw path deliberately: the
 * host validates an incoming `ui/message` request against the spec's
 * closed `McpUiMessageRequestSchema`, which strips the content-block
 * `_meta` extension and can empty the load-bearing directive text — the
 * exact failure this suite's `consumerPresent:false` + post-reload
 * regression cases lock down.
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
        sessionId: 'sess_1',
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

  describe('Pattern β (submit_action with ui/message doorbell)', () => {
    it('fires ui/update-model-context + tools/call submit_action through App transport (post-#275)', async () => {
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

      // ui/update-model-context + tools/call submit_action flow through
      // the App transport. No tools/call response is queued here, so the
      // submit_action promise never resolves and the ui/message doorbell
      // (raw postMessage, only on consumerPresent:false) cannot fire.
      // The send is async (queueMicrotask round-trip), so drain
      // microtasks before asserting on transport.sent.
      expect(postMessageSpy).not.toHaveBeenCalled();
      await tick();

      const transportMethods = transport.sent
        .map((msg) => (msg as { method?: unknown }).method)
        .filter((m): m is string => typeof m === 'string')
        // Drop the handshake noise (ui/initialize +
        // ui/notifications/initialized) so the assertion focuses on
        // the dispatch's outbound shape.
        .filter(
          (m) =>
            m !== 'ui/initialize' && m !== 'ui/notifications/initialized',
        );
      expect(transportMethods).toEqual([
        'ui/update-model-context',
        'tools/call',
      ]);

      const submitCall = transport.sent.find(
        (msg) => (msg as { method?: unknown }).method === 'tools/call',
      ) as Record<string, unknown>;
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

    it('on relay response {ok:true, consumerPresent:true} → no ui/message doorbell', async () => {
      transport.queueResponse('tools/call', {
        result: { structuredContent: { ok: true, consumerPresent: true } },
      });

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

      // Let App round-trip the request + response.
      await tick();
      await tick();

      const transportMethods = transport.sent
        .map((msg) => (msg as { method?: unknown }).method)
        .filter((m): m is string => typeof m === 'string');
      expect(transportMethods).not.toContain('ui/message');
      // The doorbell rides RAW postMessage when it fires; assert it did
      // NOT fire on that channel either.
      const rawMethods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(rawMethods).not.toContain('ui/message');
    });

    it('on relay response {ok:true} with consumerPresent absent → no ui/message doorbell', async () => {
      // Agnostic host stripped `consumerPresent`; an active consume loop
      // is assumed, so no doorbell fires.
      transport.queueResponse('tools/call', {
        result: { structuredContent: { ok: true } },
      });

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

      await tick();
      await tick();

      const transportMethods = transport.sent
        .map((msg) => (msg as { method?: unknown }).method)
        .filter((m): m is string => typeof m === 'string');
      expect(transportMethods).not.toContain('ui/message');
      const rawMethods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(rawMethods).not.toContain('ui/message');
    });

    it('on relay response {ok:true, consumerPresent:false} → pure-doorbell ui/message fires via RAW postMessage (pointer only, no payload)', async () => {
      transport.queueResponse('tools/call', {
        result: {
          structuredContent: { ok: true, consumerPresent: false },
        },
      });

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

      // Wait for the async doorbell to fire.
      await tick();
      await tick();

      // The doorbell `ui/message` MUST go out via RAW
      // `window.parent.postMessage` (postToParent), NOT `app.sendMessage`
      // — the host's closed `McpUiMessageRequestSchema` parse would strip
      // the content-block `_meta` extension and empty the text. So it
      // NEVER appears on the App `transport.sent`; it appears on the raw
      // postMessage spy instead.
      const transportMethods = transport.sent
        .map((msg) => (msg as { method?: unknown }).method)
        .filter((m): m is string => typeof m === 'string');
      expect(transportMethods).not.toContain('ui/message');

      const rawMethods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(rawMethods).toContain('ui/message');

      const uiMessage = postMessageSpy.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .find((msg) => msg.method === 'ui/message') as Record<string, unknown>;
      // Raw frame is a full JSON-RPC envelope (jsonrpc + id + method +
      // params), unlike the App-method path which only carried params.
      expect(uiMessage.jsonrpc).toBe('2.0');
      const params = uiMessage.params as Record<string, unknown>;
      expect(params.role).toBe('user');

      // Spec-canonical shape: structured pointer lives on
      // content[0]._meta["ai.ggui/userAction"], NOT on params._meta.
      const content = params.content as Array<Record<string, unknown>>;
      expect(content).toHaveLength(1);
      const firstBlock = content[0];
      expect(firstBlock.type).toBe('text');

      // THE DIRECTIVE LIVES IN THE TEXT — every host (including
      // `_meta`-agnostic ones) forwards this to the model verbatim. It
      // MUST be NON-EMPTY and carry the imperative ggui_consume
      // instruction on its own, naming ONLY the render pointer (never the
      // action), so it can't tempt a pre-consume action.
      const text = firstBlock.text as string;
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('REQUIRED FIRST TOOL CALL');
      expect(text).toContain('ggui_consume');
      expect(text).toContain('sess_1');
      expect(text).toContain('Do not respond conversationally');
      expect(text).toContain('<ggui_directive kind="user-action">');
      expect(text).toContain('<session_id>sess_1</session_id>');
      expect(text).toContain('<next_args>{"sessionId":"sess_1"}</next_args>');

      // Spec-canonical structured mirror: pointer lives on
      // content[0]._meta["ai.ggui/userAction"], NOT on params._meta.
      const blockMeta = firstBlock._meta as Record<string, unknown>;
      const userAction = blockMeta['ai.ggui/userAction'] as Record<
        string,
        unknown
      >;
      // PURE DOORBELL: kind === 'user-action', pointer to the render,
      // nextStep === ggui_consume. NO action payload, NO uiContext, NO
      // inline kind — the gesture stays solely on the pipe.
      expect(userAction.kind).toBe('user-action');
      expect(userAction.sessionId).toBe('sess_1');
      expect(userAction.payload).toBeUndefined();
      expect(userAction.nextStep).toEqual({
        tool: 'ggui_consume',
        args: { sessionId: 'sess_1' },
      });
    });

    it('post-reload re-mounted iframe → doorbell still carries NON-EMPTY directive text naming the sessionId', async () => {
      // Regression lock for the live bug: on the FIRST post-reload click
      // (the agent's persistent ggui_consume long-poll has ended, so the
      // server reports consumerPresent:false), the doorbell `ui/message`
      // was going out with EMPTY content[0].text and the host rejected
      // it. A re-mounted iframe carries a fresh, distinctly-shaped
      // sessionId; the doorbell text MUST be built reliably from THAT
      // sessionId and reach the host non-empty over the raw postMessage
      // path.
      const remountSessionId = 'render_8f3a-remounted-after-reload';
      transport.queueResponse('tools/call', {
        result: {
          structuredContent: { ok: true, consumerPresent: false },
        },
      });

      routeDispatch({
        actionName: 'toggle',
        data: { id: 'todo_2', done: true },
        meta: {
          sessionId: remountSessionId,
          appId: 'app_1',
          actionNextSteps: { toggle: 'todo_toggle' },
          appCallableTools: ['ggui_runtime_submit_action'],
        },
        dispatchToolName: 'ggui_runtime_submit_action',
      });

      await tick();
      await tick();

      const uiMessage = postMessageSpy.mock.calls
        .map((call) => call[0] as Record<string, unknown>)
        .find((msg) => msg.method === 'ui/message') as Record<string, unknown>;
      expect(uiMessage).toBeDefined();
      const params = uiMessage.params as Record<string, unknown>;
      const content = params.content as Array<Record<string, unknown>>;
      const text = content[0].text as string;

      // The host's handleAppMessage rejects with isError ONLY when the
      // joined+trimmed text is empty. Assert the exact condition that
      // failed live: non-empty text carrying ggui_consume + the
      // re-mounted sessionId.
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).toContain('ggui_consume');
      expect(text).toContain(remountSessionId);
      expect(text).toContain(
        `<next_args>{"sessionId":"${remountSessionId}"}</next_args>`,
      );

      // Structured mirror points at the same re-mounted sessionId.
      const userAction = (content[0]._meta as Record<string, unknown>)[
        'ai.ggui/userAction'
      ] as Record<string, unknown>;
      expect(userAction.sessionId).toBe(remountSessionId);
      expect(userAction.nextStep).toEqual({
        tool: 'ggui_consume',
        args: { sessionId: remountSessionId },
      });
    });

    it('on relay response {ok:false, code:PIPE_NOT_FOUND} → NO ui/message (enqueue failed, nothing to drain)', async () => {
      transport.queueResponse('tools/call', {
        result: {
          structuredContent: { ok: false, code: 'PIPE_NOT_FOUND' },
        },
      });

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

      await tick();
      await tick();

      const transportMethods = transport.sent
        .map((msg) => (msg as { method?: unknown }).method)
        .filter((m): m is string => typeof m === 'string');
      expect(transportMethods).not.toContain('ui/message');
      const rawMethods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(rawMethods).not.toContain('ui/message');
    });

    it('on relay response with JSON-RPC error → NO ui/message (enqueue failed)', async () => {
      transport.queueResponse('tools/call', {
        error: { code: -32601, message: 'no relay wired' },
      });

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

      await tick();
      await tick();

      const transportMethods = transport.sent
        .map((msg) => (msg as { method?: unknown }).method)
        .filter((m): m is string => typeof m === 'string');
      expect(transportMethods).not.toContain('ui/message');
      const rawMethods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(rawMethods).not.toContain('ui/message');
    });
  });

  it('Pattern β when actionNextSteps is absent (legacy bootstrap)', async () => {
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

    // Both ui/update-model-context and submit_action flow through the
    // App transport post-#275.
    expect(postMessageSpy).not.toHaveBeenCalled();
    await tick();
    const transportMethods = transport.sent
      .map((msg) => (msg as { method?: unknown }).method)
      .filter((m): m is string => typeof m === 'string')
      .filter(
        (m) => m !== 'ui/initialize' && m !== 'ui/notifications/initialized',
      );
    expect(transportMethods).toEqual([
      'ui/update-model-context',
      'tools/call',
    ]);
  });

  it('Pattern β when the action name is not in actionNextSteps', async () => {
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

    expect(postMessageSpy).not.toHaveBeenCalled();
    await tick();
    const transportMethods = transport.sent
      .map((msg) => (msg as { method?: unknown }).method)
      .filter((m): m is string => typeof m === 'string')
      .filter(
        (m) => m !== 'ui/initialize' && m !== 'ui/notifications/initialized',
      );
    expect(transportMethods).toEqual([
      'ui/update-model-context',
      'tools/call',
    ]);
  });

  it('Pattern β when appCallableTools is absent (legacy bootstrap)', async () => {
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

    expect(postMessageSpy).not.toHaveBeenCalled();
    await tick();
    const transportMethods = transport.sent
      .map((msg) => (msg as { method?: unknown }).method)
      .filter((m): m is string => typeof m === 'string')
      .filter(
        (m) => m !== 'ui/initialize' && m !== 'ui/notifications/initialized',
      );
    expect(transportMethods).toEqual([
      'ui/update-model-context',
      'tools/call',
    ]);
  });
});
