/**
 * Submit-action routing for `WireConfig.dispatch` — the single action
 * path: every gesture enqueues on the render's pending-event pipe via
 * `submit_action`, and the agent drains it via `ggui_consume`.
 *
 * The bridge (with its `ui/message` doorbell) synchronously fires:
 *   (1) `ui/update-model-context` — silent LLM hint.
 *   (2) `tools/call ggui_runtime_submit_action` — routed through
 *       the spec-canonical `app.callServerTool` API. Awaits the
 *       response.
 * Then asynchronously, on relay response:
 *   (3) On `{ok:true, consumerPresent:true}` (or `consumerPresent`
 *       absent) → DONE; the agent's active `ggui_consume` long-poll
 *       drains the just-enqueued gesture.
 *   (3') On `{ok:true, consumerPresent:false}` (no consume loop is
 *       listening — e.g. after a page reload) → emit the
 *       `ai.ggui/userAction` PURE DOORBELL on a `ui/message` (RAW
 *       postMessage, bypassing the host's closed-schema parse so the
 *       directive text + content-block `_meta` survive) so a fresh
 *       agent turn calls `ggui_consume({sessionId})` to drain it.
 *       Pointer-only — the gesture stays solely on the pipe.
 *   (3'') On `{ok:false}` / JSON-RPC error → the enqueue FAILED; the
 *       gesture is on no pipe, so NO `ui/message` is emitted (a
 *       doorbell would point at an empty queue). Surfaces a toast
 *       only.
 *
 * Post-Phase-1.19b.3 (2026-05-28): outbound `tools/call` from
 * `dispatchSubmitAction` flows through `app.callServerTool` on the
 * module-level App handle (`setCurrentApp`). This suite injects a
 * `MockTransport`-bound App via `setCurrentApp` so the `submit_action`
 * envelope round-trips through the spec-canonical API and the relay
 * response is delivered via `transport.queueResponse('tools/call', …)`
 * instead of a faked `MessageEvent`. `ui/update-model-context` flows
 * through the App method (`app.updateModelContext`) and is asserted on
 * `transport.sent`. The `ui/message` DOORBELL rides raw
 * `window.parent.postMessage`, so it is asserted via the
 * `postMessageSpy`. The doorbell uses the raw path deliberately: the
 * host validates an incoming `ui/message` request against the spec's
 * closed `McpUiMessageRequestSchema`, which strips the content-block
 * `_meta` extension and can empty the load-bearing directive text — the
 * exact failure this suite's `consumerPresent:false` + post-reload
 * regression cases lock down.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@modelcontextprotocol/ext-apps';
import { MCP_APP_OBSERVE_TYPE } from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  __resetAppForTest,
  __resetRelayNoticeForTest,
  channelToolsCall,
  dispatchDrainAck,
  resetRelayLatchForBoot,
  routeDispatch,
  setCurrentApp,
} from '../runtime.js';
import { ensureStatusDom } from '../status-dom.js';
import {
  __resetHostCapabilitiesForTest,
  setHostCapabilities,
} from '../host-capabilities.js';
// Imported from the package entrypoint (not '../observability.js') to pin
// that both types stay part of the published export surface.
import type {
  ObservabilityMessage,
  RelayDeadTapEvent,
  RelayIncapabilityEvent,
} from '../index.js';
import {
  RelayIncapableError,
  isRelayIncapableError,
} from '../relay-incapability.js';
import { buildBootHarness, tick } from './boot-helpers.js';
import type { MockTransport, QueueResponseOptions } from './mock-transport.js';

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

describe('routeDispatch — submit-action bridge', () => {
  describe('submit_action with ui/message doorbell', () => {
    it('fires ui/update-model-context + tools/call submit_action through App transport (post-#275)', async () => {
      routeDispatch({
        actionName: 'archive',
        data: { id: 'msg_1' },
        meta: {
          sessionId: 'sess_1',
          appId: 'app_1',
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

    it('on relay response {ok:true} with consumerPresent absent → doorbell RINGS (no confirmed consumer)', async () => {
      // A field-stripping relay host (claude.ai normalizes the tool
      // result) must be treated as "no confirmed consumer": without a
      // live channel a drain_ack can never arrive, so assuming an
      // active consume loop swallowed the gesture forever (the first
      // #471 live retest). The doorbell is pointer-only and the pipe
      // pop is exactly-once, so a redundant ring on a host that DOES
      // have a consumer costs one empty ggui_consume. Servers that can
      // answer always send an explicit `true` (the factory wires the
      // registry unconditionally), which is the only shape that stays
      // quiet — pinned by the neighboring consumerPresent:true case.
      transport.queueResponse('tools/call', {
        result: { structuredContent: { ok: true } },
      });

      routeDispatch({
        actionName: 'archive',
        data: { id: 'msg_1' },
        meta: {
          sessionId: 'sess_1',
          appId: 'app_1',
        },
        dispatchToolName: 'ggui_runtime_submit_action',
      });

      await tick();
      await tick();

      const rawMethods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(rawMethods).toContain('ui/message');
    });

    it('a text-only normalized relay result still classifies success and rings the doorbell', async () => {
      // claude.ai's live behavior: the relayed CallToolResult arrives
      // with ONLY a content[0].text block carrying the JSON payload —
      // no structuredContent. The payload unwrap must parse the text
      // tier or a successful enqueue reads as a failure (toast, no
      // doorbell, latch pressure).
      transport.queueResponse('tools/call', {
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ok: true, consumerPresent: false }),
            },
          ],
        },
      });

      routeDispatch({
        actionName: 'archive',
        data: { id: 'msg_2' },
        meta: {
          sessionId: 'sess_1',
          appId: 'app_1',
        },
        dispatchToolName: 'ggui_runtime_submit_action',
      });

      await tick();
      await tick();

      const rawMethods = postMessageSpy.mock.calls.map(
        (call) => (call[0] as { method?: unknown }).method,
      );
      expect(rawMethods).toContain('ui/message');
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
});

describe('doorbell honesty on a host without the message capability (ggui#440)', () => {
  beforeEach(() => {
    __resetHostCapabilitiesForTest();
    // Earlier tests in this file (PIPE_NOT_FOUND / RPC-error cases) can
    // latch the relay-incapability notice; without this reset that
    // state leaks into this describe's tests via the shared module.
    __resetRelayNoticeForTest();
  });

  it('still POSTS the doorbell when the host advertised nothing (fail-safe)', async () => {
    // Boot with hostCapabilities {} ; relay succeeds, no consumer.
    setHostCapabilities({});
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true, consumerPresent: false } },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();

    const doorbell = postMessageSpy.mock.calls.find(
      ([msg]) => (msg as { method?: string }).method === 'ui/message',
    );
    expect(doorbell).toBeDefined();
  });

  it('does NOT tell the user it was sent to chat when the host cannot receive messages', async () => {
    setHostCapabilities({});
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true, consumerPresent: false } },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();

    const toast = document.getElementById('__ggui-action-toast__');
    expect(toast?.textContent).not.toMatch(/sent to chat/i);
    // It must tell the user what to DO — the agent can only be woken
    // by a message the user sends themselves on this host.
    expect(toast?.textContent).toMatch(/send a message|message the agent/i);
  });

  it('keeps the "sent to chat" wording on a host that advertised message', async () => {
    // Boot with hostCapabilities { message: {} } — the doorbell will
    // actually arrive, so the original reassurance is accurate.
    setHostCapabilities({ message: {} });
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true, consumerPresent: false } },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();

    const toast = document.getElementById('__ggui-action-toast__');
    expect(toast?.textContent).toMatch(/sent to chat/i);
  });
});

describe('relay-incapability is explained once, not per gesture (ggui#440)', () => {
  beforeEach(() => {
    __resetHostCapabilitiesForTest();
    __resetRelayNoticeForTest();
  });

  it('latches a persistent explanation when a host that never advertised serverTools fails the relay', async () => {
    // Handshake resolved and the host advertised nothing — distinct
    // from "hasn't connected yet" (see the pre-capture test below).
    // The relay call errors at transport. Expected: ONE persistent
    // `action_required` notice explaining the host cannot relay — not
    // a fresh `error` toast per click.
    setHostCapabilities({});
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });

    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    // Two ticks let the App round-trip the request + reply, matching
    // the convention used by every other terminal-state assertion in
    // this file (e.g. the consumerPresent tests above).
    await tick();
    await tick();
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();

    const toast = document.getElementById('__ggui-action-toast__');
    expect(toast?.textContent).toMatch(/cannot relay|can't relay/i);
    // The explanation must not name a specific host product (OSS Purity).
    expect(toast?.textContent).not.toMatch(/guuey|claude\.ai|chatgpt/i);
  });

  it('still ATTEMPTS the relay on a host that advertised nothing (fail-safe)', async () => {
    // Under-advertising is common — ggui's own embed host did it. The
    // capability must never gate the attempt.
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true, consumerPresent: true } },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    expect(transport.methodsSeen).toContain('tools/call');
  });

  it('keeps the per-gesture transient toast when the host DID advertise serverTools', async () => {
    // A capable host that failed one call is a transient failure, not a
    // structural one — wording must not blame the host's capabilities.
    // Boot this test's capability state as a fully-capable host so the
    // guard on the terminal-failure branch reads false and falls
    // through to the ordinary per-gesture toast.
    setHostCapabilities({ serverTools: {} });
    transport.queueResponse('tools/call', {
      error: { code: -32603, message: 'internal error' },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    // Two ticks let the App round-trip the request + reply so the
    // assertion observes the terminal-branch toast, not the earlier
    // `pending` state.
    await tick();
    await tick();

    const toast = document.getElementById('__ggui-action-toast__');
    expect(toast?.textContent).not.toMatch(/cannot relay|can't relay/i);
  });
});

describe('channel-transport router toolsCall guard is confirmed-failure-keyed, not advertisement-keyed (ggui#440)', () => {
  beforeEach(() => {
    __resetHostCapabilitiesForTest();
    __resetRelayNoticeForTest();
  });

  it('still ATTEMPTS the transport call on a host that advertised nothing and has had no failed gesture (fail-safe)', async () => {
    // Under-advertising is common — ggui's own embed host did it pre-
    // Task-2. Raw advertisement absence alone must never gate the
    // channel router's poll attempt; only a CONFIRMED failure (a real
    // gesture that actually failed) may.
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true } },
    });
    const result = await channelToolsCall({
      toolName: 'some_channel_tool',
      args: {},
    });
    expect(transport.methodsSeen).toContain('tools/call');
    expect(result).toEqual({ ok: true });
  });

  it('fails fast without calling the transport once a gesture has confirmed the host cannot relay', async () => {
    // Handshake resolved and the host advertised nothing (captured).
    // Latch the relay-incapability notice via a REAL failed gesture
    // first (mirrors the "latches a persistent explanation" test
    // above), then assert the channel router's next poll fails fast.
    setHostCapabilities({});
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();

    const methodsSeenAfterLatch = transport.methodsSeen.length;
    await expect(
      channelToolsCall({ toolName: 'some_channel_tool', args: {} }),
    ).rejects.toThrow(
      'tools/call unavailable: host did not advertise serverTools',
    );
    // No new outbound message — the guard threw BEFORE calling
    // `callServerToolSpec`, so the transport never saw this attempt.
    expect(transport.methodsSeen.length).toBe(methodsSeenAfterLatch);
  });
});

describe('relay-shaped vs result-shaped failure — latch precision (ggui#440)', () => {
  beforeEach(() => {
    __resetHostCapabilitiesForTest();
    __resetRelayNoticeForTest();
  });

  it('a well-formed {ok:false} result does NOT latch — per-gesture toast stays transient, and channel polling still attempts', async () => {
    // Handshake resolved; host advertised nothing. A RESULT envelope
    // arrives — proof the relay itself worked; the pipe was simply
    // gone (the common expired-pipe case). This must NOT be mistaken
    // for "this host cannot relay".
    setHostCapabilities({});
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: false, code: 'PIPE_NOT_FOUND' } },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();

    const toast = document.getElementById('__ggui-action-toast__');
    // Ordinary transient wording, NOT the persistent "cannot relay" notice.
    expect(toast?.textContent).not.toMatch(/cannot relay|can't relay/i);
    expect(toast?.textContent).toMatch(/could not reach the agent/i);

    // No false latch — the channel router must still ATTEMPT.
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true } },
    });
    await expect(
      channelToolsCall({ toolName: 'some_channel_tool', args: {} }),
    ).resolves.toEqual({ ok: true });
  });

  it('an error-shaped relay failure BEFORE capabilities were captured does NOT latch', async () => {
    // Deliberately skip `setHostCapabilities(...)` — this simulates a
    // gesture firing in the mount-to-handshake window, where capability
    // absence means "not asked yet", not "advertised nothing".
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();

    const toast = document.getElementById('__ggui-action-toast__');
    expect(toast?.textContent).not.toMatch(/cannot relay|can't relay/i);

    // No false latch — the channel router must still ATTEMPT.
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true } },
    });
    await expect(
      channelToolsCall({ toolName: 'some_channel_tool', args: {} }),
    ).resolves.toEqual({ ok: true });
  });

  it('a successful gesture after a latch clears it — notice resets, channel polling attempts again', async () => {
    // First: a REAL, captured, relay-shaped failure latches the notice.
    setHostCapabilities({});
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();

    const toast = document.getElementById('__ggui-action-toast__');
    expect(toast?.textContent).toMatch(/cannot relay|can't relay/i);
    await expect(
      channelToolsCall({ toolName: 'some_channel_tool', args: {} }),
    ).rejects.toThrow(
      'tools/call unavailable: host did not advertise serverTools',
    );

    // Now: a successful gesture — proof the relay actually works — must
    // clear the (false) latch.
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true, consumerPresent: true } },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();

    // The latch is cleared — the channel router attempts again instead
    // of throwing.
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true } },
    });
    await expect(
      channelToolsCall({ toolName: 'some_channel_tool', args: {} }),
    ).resolves.toEqual({ ok: true });
  });
});

describe('latch transitions — unlatch on ANY result envelope + edge observability (ggui#440 residuals)', () => {
  beforeEach(() => {
    __resetHostCapabilitiesForTest();
    __resetRelayNoticeForTest();
  });

  /**
   * All observability envelopes posted so far, any kind.
   * `postObservabilityToParent` rides the same raw
   * `window.parent.postMessage` as the doorbell, so the events land on
   * `postMessageSpy` wrapped in the `ggui:observe` envelope — narrowed
   * out of the heterogeneous spy traffic by the envelope discriminant.
   */
  function observabilityMessages(): ObservabilityMessage[] {
    return postMessageSpy.mock.calls
      .map(([msg]) => msg as { type?: unknown })
      .filter(
        (msg): msg is ObservabilityMessage => msg.type === MCP_APP_OBSERVE_TYPE,
      );
  }

  /** Just the `relay-incapability` events, in emission order. */
  function relayIncapabilityEvents(): RelayIncapabilityEvent[] {
    return observabilityMessages()
      .map((msg) => msg.event)
      .filter(
        (event): event is RelayIncapabilityEvent =>
          event.kind === 'relay-incapability',
      );
  }

  /**
   * Latch the relay-incapability notice the only legitimate way: a
   * REAL gesture that fails relay-shaped (JSON-RPC error envelope) on
   * a host whose captured handshake advertised nothing.
   */
  async function latchViaFailedGesture(): Promise<void> {
    setHostCapabilities({});
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });
    // A preceding test in this file can leave the singleton
    // `#__ggui-action-toast__` element standing in jsdom with
    // "cannot relay" text of its own — removing it here means any
    // later assertion matching that text can ONLY be satisfied by a
    // transition THIS call produces, not inherited residual DOM
    // (ggui#440 residuals Minor 6).
    document.getElementById('__ggui-action-toast__')?.remove();
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();
  }

  it('throws the TYPED structural error the router classifies on, not a bare Error (ggui#443)', async () => {
    await latchViaFailedGesture();

    // This is the thrower↔classifier seam. `channel-transport.ts`'s
    // tick decides "drop to probe cadence" vs "stay quiet, next tick
    // may succeed" from the TYPE of this rejection alone — it never
    // reads the message. Swapping this throw back to a bare `Error`
    // carrying the same text would leave every message-based
    // assertion in this file green while silently restoring the #443
    // defect: a doomed channel polling at full cadence forever.
    const rejection: unknown = await channelToolsCall({
      toolName: 'some_channel_tool',
      args: {},
    }).catch((err: unknown) => err);
    expect(rejection).toBeInstanceOf(RelayIncapableError);
    // …and the classifier's OWN predicate — the exact function the
    // router's tick calls — agrees. Asserting the guard rather than
    // only `instanceof` means a change to how the router classifies
    // is caught here too, not just a change to what runtime throws.
    expect(isRelayIncapableError(rejection)).toBe(true);
  });

  it('a latched session receiving a well-formed {ok:false} result unlatches — channel polling attempts again and the per-gesture transient toast shows', async () => {
    await latchViaFailedGesture();
    // Sanity: latched — persistent notice standing, channel router frozen.
    expect(
      document.getElementById('__ggui-action-toast__')?.textContent,
    ).toMatch(/cannot relay|can't relay/i);
    await expect(
      channelToolsCall({ toolName: 'some_channel_tool', args: {} }),
    ).rejects.toThrow(
      'tools/call unavailable: host did not advertise serverTools',
    );

    // A well-formed {ok:false} RESULT envelope (expired pipe, the
    // common case) is proof the host CAN relay — equally as much as an
    // {ok:true} — so it must clear the latch, not just fail the
    // gesture.
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: false, code: 'PIPE_NOT_FOUND' } },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();

    // The gesture still failed (enqueue-wise), but the feedback is the
    // ordinary per-gesture transient toast — the persistent notice no
    // longer applies to a host that just proved it can relay.
    const toast = document.getElementById('__ggui-action-toast__');
    expect(toast?.textContent).not.toMatch(/cannot relay|can't relay/i);
    expect(toast?.textContent).toMatch(/could not reach the agent/i);

    // The latch is cleared — the channel router attempts the transport
    // again instead of throwing pre-transport.
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true } },
    });
    await expect(
      channelToolsCall({ toolName: 'some_channel_tool', args: {} }),
    ).resolves.toEqual({ ok: true });
  });

  it('a successful gesture after a latch replaces the stale "cannot relay" notice with the normal pending toast (ggui#440 residuals Minor 1)', async () => {
    await latchViaFailedGesture();
    expect(
      document.getElementById('__ggui-action-toast__')?.textContent,
    ).toMatch(/cannot relay|can't relay/i);

    // A successful gesture clears the latch (see the {ok:false} test
    // above), but clearing alone leaves the stale persistent notice on
    // screen with no successor: the initial `pending` toast at dispatch
    // time was skipped because the latch was still standing when this
    // gesture fired (see the "(1.5)" skip in `dispatchSubmitAction`).
    // The clear guard must replace the stale notice with the ordinary
    // pending toast so the normal drain_ack dismissal chain has a
    // predecessor to dismiss — otherwise the now-false "cannot relay"
    // notice stands until a `drain_ack` frame that may never arrive in
    // MCP-Apps relay contexts.
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true, consumerPresent: true } },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();

    const toast = document.getElementById('__ggui-action-toast__');
    expect(toast?.textContent).not.toMatch(/cannot relay|can't relay/i);
    expect(toast?.textContent).toBe('→ archive');
  });

  it('emits exactly one relay-incapability observability event per transition edge — repeated failing gestures add no duplicate latched events (they are dead taps, summarized at the cleared edge)', async () => {
    await latchViaFailedGesture();
    expect(relayIncapabilityEvents()).toEqual([
      { kind: 'relay-incapability', state: 'latched', trigger: 'confirmed-refusal', sessionId: 'sess_1', appId: 'app_1' },
    ]);

    // A SECOND failing gesture while already latched is not a
    // transition — no additional 'latched' event may fire.
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();
    expect(relayIncapabilityEvents()).toEqual([
      { kind: 'relay-incapability', state: 'latched', trigger: 'confirmed-refusal', sessionId: 'sess_1', appId: 'app_1' },
    ]);

    // The clearing response is the other edge — exactly one 'cleared'.
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: false, code: 'PIPE_NOT_FOUND' } },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();
    expect(relayIncapabilityEvents()).toEqual([
      { kind: 'relay-incapability', state: 'latched', trigger: 'confirmed-refusal', sessionId: 'sess_1', appId: 'app_1' },
      // The repeated failing gesture above was the zone's one dead tap;
      // the {ok:false} gesture healed it and is the edge, not a tap.
      { kind: 'relay-incapability', state: 'cleared', latchedForMs: expect.any(Number), deadTaps: 1, sessionId: 'sess_1', appId: 'app_1' },
    ]);
  });

  it('channel ticks while latched emit no observability events, and a later clearing gesture still emits exactly the cleared edge', async () => {
    await latchViaFailedGesture();
    const before = observabilityMessages().length;

    // The router's poll loop keeps ticking while latched (its catch
    // swallows the throw) — each tick fails fast pre-transport and
    // must post NOTHING to the observability seam; the transition
    // edges already carried the full information.
    for (let i = 0; i < 3; i += 1) {
      await expect(
        channelToolsCall({ toolName: 'some_channel_tool', args: {} }),
      ).rejects.toThrow(
        'tools/call unavailable: host did not advertise serverTools',
      );
    }
    expect(observabilityMessages().length).toBe(before);

    // Revert-sensitivity: the per-tick silence above is not, by
    // itself, proof the latch machinery still works — a revert that
    // also broke the clear-edge emission would pass the assertion
    // above vacuously. A REAL clearing gesture after the silent ticks
    // must add exactly one new observability event: the 'cleared' edge.
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: false, code: 'PIPE_NOT_FOUND' } },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();

    const afterEvents = observabilityMessages();
    expect(afterEvents.length).toBe(before + 1);
    expect(afterEvents[afterEvents.length - 1]?.event).toEqual({
      kind: 'relay-incapability',
      state: 'cleared',
      latchedForMs: expect.any(Number),
      deadTaps: 0,
      sessionId: 'sess_1',
      appId: 'app_1',
    });
  });
});

describe('post-dismissal cue in the relay dead zone (ggui#442)', () => {
  const CUE_CLASS = 'ggui-relay-cue-pulse';
  const CUE_STYLE_ID = 'ggui-relay-cue-style';
  const TOAST_ID = '__ggui-action-toast__';

  beforeEach(() => {
    __resetHostCapabilitiesForTest();
    __resetRelayNoticeForTest();
    document.getElementById(TOAST_ID)?.remove();
    document.getElementById(CUE_STYLE_ID)?.remove();
    document.querySelector('[data-ggui-session-root]')?.remove();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function toastEl(): HTMLElement | null {
    return document.getElementById(TOAST_ID);
  }

  /** A session root holding one focusable control, as a render would. */
  function mountSessionRoot(): HTMLButtonElement {
    const root = document.createElement('ul');
    root.setAttribute('data-ggui-session-root', '');
    const btn = document.createElement('button');
    root.appendChild(btn);
    document.body.appendChild(root);
    return btn;
  }

  function fireGesture(): void {
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
  }

  /**
   * Latch the notice the only legitimate way (a real relay-shaped
   * gesture failure on a host that advertised nothing), then DISMISS it
   * the only way a user can — by clicking the persistent toast. That
   * click is the consent this issue defends: it must never be undone by
   * re-showing the notice.
   */
  async function latchAndDismiss(): Promise<void> {
    setHostCapabilities({});
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });
    fireGesture();
    await tick();
    await tick();
    const el = toastEl();
    expect(el?.textContent).toMatch(/cannot relay/i);
    el?.click();
    expect(el?.style.opacity).toBe('0');
  }

  it('pulses the focused in-root control, then removes the class', async () => {
    await latchAndDismiss();
    const btn = mountSessionRoot();
    btn.focus();
    expect(document.activeElement).toBe(btn);

    vi.useFakeTimers();
    fireGesture();

    expect(btn.classList.contains(CUE_CLASS)).toBe(true);
    // The keyframes ride an injected <style>, matching how the renderer
    // injects its own theme CSS (stable id, idempotent, on <head>).
    const style = document.getElementById(CUE_STYLE_ID);
    expect(style).not.toBeNull();
    expect(style?.textContent).toContain(`@keyframes ${CUE_CLASS}`);
    // The persistent notice is NOT re-shown — dismissed consent stands.
    expect(toastEl()?.style.opacity).toBe('0');

    // jsdom never fires `animationend`, so the class comes off via the
    // timeout belt. Real browsers take whichever fires first.
    vi.advanceTimersByTime(1_000);
    expect(btn.classList.contains(CUE_CLASS)).toBe(false);

    // The session root itself is NOT a target: `contains` is reflexive,
    // so without an explicit guard a focused root pulses the entire
    // render instead of one control. Reachable because the root is
    // reused when one already exists, so anything may give it a
    // tabindex and focus it.
    const root = btn.parentElement;
    root?.setAttribute('tabindex', '-1');
    (root as HTMLElement | null)?.focus();
    expect(document.activeElement).toBe(root);
    fireGesture();
    expect(root?.classList.contains(CUE_CLASS)).toBe(false);
    // …it falls through to the toast instead, like any other gesture
    // with nothing usable focused.
    expect(toastEl()?.textContent).toContain('archive');
  });

  it('does not let a finished pulse truncate the next one', async () => {
    // When `animationend` wins the race, its timeout twin is still
    // armed. If that stale timer is not cancelled it fires later and
    // strips whatever class is on the element AT THAT MOMENT — which
    // is the NEXT pulse, cut short partway through.
    await latchAndDismiss();
    const btn = mountSessionRoot();
    btn.focus();

    vi.useFakeTimers();
    fireGesture();
    expect(btn.classList.contains(CUE_CLASS)).toBe(true);

    // Pulse 1 ends the way a real browser ends it. jsdom never emits
    // this on its own, so dispatch it — that IS the race being pinned.
    vi.advanceTimersByTime(400);
    btn.dispatchEvent(new Event('animationend'));
    expect(btn.classList.contains(CUE_CLASS)).toBe(false);

    // Pulse 2, inside pulse 1's original timeout window.
    vi.advanceTimersByTime(50);
    fireGesture();
    expect(btn.classList.contains(CUE_CLASS)).toBe(true);

    // Past the moment pulse 1's timer would have fired. Pulse 2 must
    // still be running.
    vi.advanceTimersByTime(60);
    expect(btn.classList.contains(CUE_CLASS)).toBe(true);

    // …and it still ends on its own schedule.
    vi.advanceTimersByTime(1_000);
    expect(btn.classList.contains(CUE_CLASS)).toBe(false);
  });

  it('falls back to one throttled micro-toast when no in-root control is focused', async () => {
    await latchAndDismiss();
    // Nothing focused: jsdom leaves `document.body` as activeElement,
    // which is exactly the "no usable target" case.
    expect(document.activeElement).toBe(document.body);

    vi.useFakeTimers();
    fireGesture();
    const first = toastEl()?.textContent ?? '';
    expect(first).toContain('archive');
    expect(toastEl()?.style.opacity).toBe('1');

    // A second gesture inside the throttle window adds nothing.
    if (toastEl() !== null) toastEl()!.textContent = '';
    vi.advanceTimersByTime(1_000);
    fireGesture();
    expect(toastEl()?.textContent).toBe('');

    // Past the window, the cue is allowed to speak again.
    vi.advanceTimersByTime(5_000);
    fireGesture();
    expect(toastEl()?.textContent).toBe(first);
  });

  it('arms only in the latched state — an unlatched gesture keeps the ordinary pending toast and cues nothing', async () => {
    const btn = mountSessionRoot();
    btn.focus();

    fireGesture();

    expect(toastEl()?.textContent).toBe('→ archive');
    expect(btn.classList.contains(CUE_CLASS)).toBe(false);
    expect(document.getElementById(CUE_STYLE_ID)).toBeNull();
    await tick();
  });

  it('leaves no cue residue after the latch self-heals', async () => {
    await latchAndDismiss();
    const btn = mountSessionRoot();
    btn.focus();

    vi.useFakeTimers();
    // A well-formed envelope clears the latch (ggui#440 self-heal).
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true, consumerPresent: true } },
    });
    fireGesture();
    // This gesture was DISPATCHED inside the dead zone, so it is cued —
    // at dispatch time the host was still believed relay-incapable.
    expect(btn.classList.contains(CUE_CLASS)).toBe(true);

    // Flush the response (clears the latch) and the cue's own cleanup.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(btn.classList.contains(CUE_CLASS)).toBe(false);

    // The next gesture is back on the normal path: ordinary pending
    // toast, no pulse. Nothing the dead zone set is still armed — had
    // `relayNoticeDismissed` survived the clear, a later re-latch would
    // skip its own notice's dismissal and cue from the first gesture.
    fireGesture();
    expect(toastEl()?.textContent).toBe('→ archive');
    expect(btn.classList.contains(CUE_CLASS)).toBe(false);
  });

  it('does not cue over a FRESH notice after a re-latch — dismissal does not carry across latch cycles', async () => {
    // The residue this pins is only observable across a re-latch.
    // Post-self-heal the latch is false, so the cue branch is
    // unreachable and a stale `relayNoticeDismissed` hides; it becomes
    // visible only once a SECOND dead zone opens, where it would
    // suppress the new notice's own dismissal step and cue from the
    // very first gesture.
    await latchAndDismiss();

    // Self-heal.
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true, consumerPresent: true } },
    });
    fireGesture();
    await tick();
    await tick();

    // Re-latch: a fresh notice the user has NOT dismissed.
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });
    fireGesture();
    await tick();
    await tick();
    expect(toastEl()?.textContent).toMatch(/cannot relay/i);
    expect(toastEl()?.style.opacity).toBe('1');

    const btn = mountSessionRoot();
    btn.focus();
    fireGesture();

    // No cue. The user must READ the new notice; a subtle pulse in its
    // place would silently downgrade an explanation they never saw.
    expect(btn.classList.contains(CUE_CLASS)).toBe(false);
    expect(toastEl()?.textContent).toMatch(/cannot relay/i);
    expect(toastEl()?.style.opacity).toBe('1');
  });
});

describe('confirmed-refusal latch precision — attempt outcome outranks advertisement (ggui#599 cycle-2)', () => {
  beforeEach(() => {
    __resetHostCapabilitiesForTest();
    __resetRelayNoticeForTest();
    document.getElementById('__ggui-action-toast__')?.remove();
  });

  function relayEvents(): RelayIncapabilityEvent[] {
    return postMessageSpy.mock.calls
      .map(([msg]) => msg as { type?: unknown })
      .filter(
        (msg): msg is ObservabilityMessage => msg.type === MCP_APP_OBSERVE_TYPE,
      )
      .map((msg) => msg.event)
      .filter(
        (event): event is RelayIncapabilityEvent =>
          event.kind === 'relay-incapability',
      );
  }

  async function dispatchOnce(): Promise<void> {
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();
  }

  it('an advertises-but-refuses host (-32601 under serverTools) LATCHES — the H2 worst dead-tap shape', async () => {
    // Pre-#599-cycle-2 this shape could never latch: the advertisement
    // gate read the host as capable, so every tap got a fresh transient
    // toast forever. A declared refusal code is helper-minted proof of
    // incapability that outranks what the handshake advertised —
    // classification keys on confirmed attempt outcomes, never
    // advertisement (#440's own doctrine, applied symmetrically).
    setHostCapabilities({ serverTools: {} });
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });
    await dispatchOnce();

    const toast = document.getElementById('__ggui-action-toast__');
    expect(toast?.textContent).toMatch(/cannot relay|can't relay/i);
  });

  it('-32000 under advertisement stays TRANSIENT — the ConnectionClosed collision keeps it out of the registry', async () => {
    // -32000 is the MCP SDK's ErrorCode.ConnectionClosed: at this
    // catch a helper-minted -32000 and an SDK-local transport loss are
    // the same object, and a transport loss must never classify. The
    // one live -32000 refusal minter (RN no-tool-handler) was fixed at
    // source to -32601 in this same slice; a third-party helper still
    // minting -32000 degrades to per-gesture transient toasts — honest,
    // never falsely inert. (This is also the MockTransport default for
    // code-less errors, so this case doubles as the code-less pin.)
    setHostCapabilities({ serverTools: {} });
    transport.queueResponse('tools/call', {
      error: { code: -32000, message: 'no-tool-handler' },
    });
    await dispatchOnce();

    const toast = document.getElementById('__ggui-action-toast__');
    expect(toast?.textContent).not.toMatch(/cannot relay|can't relay/i);
    expect(toast?.textContent).toMatch(/could not reach/i);
  });

  it('an unknown error code under advertisement stays transient — unknown codes never classify', async () => {
    // -32050 is nobody's declared refusal: it could be server-side,
    // proxy-minted, anything. Classifying it would misbrand capable
    // mounts; it stays on the per-gesture transient path.
    setHostCapabilities({ serverTools: {} });
    transport.queueResponse('tools/call', {
      error: { code: -32050, message: 'mystery' },
    });
    await dispatchOnce();

    const toast = document.getElementById('__ggui-action-toast__');
    expect(toast?.textContent).not.toMatch(/cannot relay|can't relay/i);
    expect(toast?.textContent).toMatch(/could not reach/i);
  });

  it("the latched observability event names its trigger: 'confirmed-refusal'", async () => {
    setHostCapabilities({ serverTools: {} });
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });
    await dispatchOnce();

    const latched = relayEvents().find((e) => e.state === 'latched');
    expect(latched).toBeDefined();
    expect(latched?.trigger).toBe('confirmed-refusal');
  });

  it("the advert-silent path reports trigger: 'advert-silent' (non-registry failure, nothing advertised)", async () => {
    setHostCapabilities({});
    transport.queueResponse('tools/call', {
      // Mock coerces code-less to -32000 — outside the registry, so
      // only the advert-silent leg can latch this.
      error: { message: 'socket dropped' },
    });
    await dispatchOnce();

    const latched = relayEvents().find((e) => e.state === 'latched');
    expect(latched).toBeDefined();
    expect(latched?.trigger).toBe('advert-silent');
  });

  it('a confirmed-refusal latch self-heals on the next well-formed result — the response-arrival clear covers the new path', async () => {
    setHostCapabilities({ serverTools: {} });
    transport.queueResponse('tools/call', {
      error: { code: -32601, message: 'method not supported' },
    });
    await dispatchOnce();
    expect(relayEvents().some((e) => e.state === 'latched')).toBe(true);

    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: true, consumerPresent: true } },
    });
    await dispatchOnce();

    const events = relayEvents();
    expect(events[events.length - 1]?.state).toBe('cleared');
  });
});

describe('relay dead zone — truth surface + instrument (ggui#670 Phase 3)', () => {
  // The Phase-3 adversarial pass found the runtime dishonest at HEAD in
  // two reachable classes: a late `drain_ack` retires the standing
  // notice without flipping the dismissed flag, and toast-disabled
  // hosts never get the notice — after either, every attempt in the
  // dead zone is SILENT. The cue must arm on "notice not visible", not
  // on the user's click. The instrument makes every attempt countable.
  const REFUSAL: QueueResponseOptions = { error: { code: -32601, message: 'method not supported' } };
  const DELIVERED: QueueResponseOptions = { result: { structuredContent: { ok: true, consumerPresent: true } } };
  const TOAST_ID = '__ggui-action-toast__';
  /** The zone summary a `cleared` edge carries — narrows the discriminated union. */
  function summary(e: RelayIncapabilityEvent | undefined): { deadTaps: number; latchedForMs: number } | undefined {
    return e?.state === 'cleared' ? { deadTaps: e.deadTaps, latchedForMs: e.latchedForMs } : undefined;
  }

  beforeEach(() => {
    __resetHostCapabilitiesForTest();
    __resetRelayNoticeForTest();
    document.getElementById(TOAST_ID)?.remove();
    document.querySelector('[data-ggui-session-root]')?.remove();
  });

  function observed(): ObservabilityMessage['event'][] {
    return postMessageSpy.mock.calls
      .map(([msg]) => msg as { type?: unknown })
      .filter((msg): msg is ObservabilityMessage => msg.type === MCP_APP_OBSERVE_TYPE)
      .map((msg) => msg.event);
  }
  function deadTaps(): RelayDeadTapEvent[] {
    return observed().filter((e): e is RelayDeadTapEvent => e.kind === 'relay-dead-tap');
  }
  function relay(): RelayIncapabilityEvent[] {
    return observed().filter((e): e is RelayIncapabilityEvent => e.kind === 'relay-incapability');
  }
  async function attempt(intent = 'archive', resp: QueueResponseOptions = REFUSAL): Promise<void> {
    transport.queueResponse('tools/call', resp);
    routeDispatch({
      actionName: intent,
      data: {},
      meta: { sessionId: 'sess_1', appId: 'app_1' },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();
  }
  async function latch(): Promise<void> {
    setHostCapabilities({ serverTools: {} });
    await attempt();
    expect(relay().at(-1)?.state).toBe('latched');
  }
  const toast = (): HTMLElement | null => document.getElementById(TOAST_ID);

  it('a drain_ack that retires the standing notice does not silence the dead zone — the next attempt still cues (truth-2)', async () => {
    await latch();
    expect(toast()?.textContent).toMatch(/cannot relay/i);
    // A late ack for an EARLIER delivered gesture (the #599 advertises-
    // but-refuses class) dismisses whatever action toast is up — the
    // notice included — by a path that is not the user's click.
    dispatchDrainAck({
      appId: 'app_1',
      sessionId: 'sess_1',
      eventId: 'evt_earlier_success',
      drainedAt: new Date().toISOString(),
    });
    expect(toast()?.style.opacity === '0' || toast() === null).toBe(true);
    await attempt();
    // No focused control in this document → the fallback cue toast.
    expect(toast()?.textContent).toMatch(/not delivered/);
    expect(toast()?.style.opacity).not.toBe('0');
  });

  it('boot while latched routes through the latch writer: emits cleared with the summary and removes the prior notice (truth-5)', async () => {
    await latch();
    await attempt(); // one dead tap
    resetRelayLatchForBoot();
    const last = relay().at(-1);
    expect(last?.state).toBe('cleared');
    expect(summary(last)?.deadTaps).toBe(1);
    expect(summary(last)?.latchedForMs).toBeGreaterThanOrEqual(0);
    expect(toast()).toBeNull();
  });

  it('emits exactly one relay-dead-tap per attempt while latched (latch age, ordinal, appId); none before the latch, none after the clear', async () => {
    setHostCapabilities({ serverTools: {} });
    await attempt('archive', DELIVERED);
    expect(deadTaps()).toHaveLength(0);
    await attempt(); // the latching gesture IS the 'latched' edge, not a dead tap
    expect(relay().at(-1)?.state).toBe('latched');
    expect(deadTaps()).toHaveLength(0);
    await attempt();
    await attempt('save');
    const taps = deadTaps();
    expect(taps.map((t) => t.ordinal)).toEqual([1, 2]);
    expect(taps[1]).toMatchObject({
      intent: 'save',
      trigger: 'confirmed-refusal',
      appId: 'app_1',
      sessionId: 'sess_1',
    });
    expect(taps[0]?.latchAgeMs).toBeGreaterThanOrEqual(0);
    await attempt('archive', DELIVERED); // clears
    const cleared = relay().at(-1);
    expect(cleared).toMatchObject({ state: 'cleared', deadTaps: 2, appId: 'app_1', sessionId: 'sess_1' });
    expect(summary(cleared)?.latchedForMs).toBeGreaterThanOrEqual(0);
    await attempt('archive', DELIVERED);
    expect(deadTaps()).toHaveLength(2);
  });

  it('the channel router fail-fast while latched emits no relay-dead-tap — one event per user gesture, never per tick', async () => {
    await latch();
    await expect(
      channelToolsCall({ toolName: 'ggui_runtime_subscribe', args: {} }),
    ).rejects.toBeInstanceOf(RelayIncapableError);
    expect(deadTaps()).toHaveLength(0);
  });

  it('the standing notice precedes the render root in document order — the explanation is met before the dead controls (a11y-4)', async () => {
    ensureStatusDom(document);
    await latch();
    const notice = toast();
    const root = document.querySelector('[data-ggui-session-root]');
    expect(notice).not.toBeNull();
    expect(root).not.toBeNull();
    expect(notice!.compareDocumentPosition(root!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});
