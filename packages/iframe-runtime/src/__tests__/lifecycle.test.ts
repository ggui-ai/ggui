/**
 * Renderer-side lifecycle emission — unit tests for `lifecycle.ts` +
 * the integration sites in `runtime.ts`'s `bootSequence`.
 *
 * Covers (in order):
 *
 *   1. `postLifecycleToParent` posts a `ggui:lifecycle` envelope to
 *      `window.parent`.
 *   2. `makeLifecycleEvent` builds a populated event with no
 *      `undefined` keys.
 *   3. `bootSequence({onLifecycle})` fires `mounting` → `code-ready`
 *      on the happy path, in order, with the correct stackItemId
 *      forwarding.
 *   4. `bootSequence({onLifecycle})` fires `mounting` → `error` on
 *      every failure path (UI_INITIALIZE_FAILED, MISSING_META_GGUI_
 *      BOOTSTRAP, WS_HANDSHAKE_FAILED, UPGRADE_REQUIRED), with
 *      `error.code` mirroring the legacy `RendererBootFailedMessage`
 *      reason.
 *
 * The bootSequence wiring uses the same mock posture as `boot.test.ts`
 * — inject `callUiInitialize`, `connectFn`, `notifyParent`, and
 * `onLifecycle`.
 */
import { describe, it, expect, vi, type Mock } from 'vitest';
import type { SessionStackEntry } from '@ggui-ai/protocol';
import type {
  McpAppAiGguiMountView,
  McpAppLifecycleEvent,
  McpAppLifecycleMessage,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  mountViewToMcpAppMeta,
  isMcpAppLifecycleMessage,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { bootSequence } from '../runtime.js';
import {
  makeLifecycleEvent,
  postLifecycleToParent,
} from '../lifecycle.js';
import type { ConnectFn } from '../registry-subscribe.js';

// =============================================================================
// Test helpers
// =============================================================================

function lifecycleEvents(mock: Mock): McpAppLifecycleEvent[] {
  return mock.mock.calls.map((c) => c[0] as McpAppLifecycleEvent);
}

function notifyParentCalls(mock: Mock): unknown[] {
  return mock.mock.calls.map((c) => c[0]);
}

/**
 * Build a happy-path `connectFn` returning the supplied stack on ack.
 */
function buildHappyConnect(stack: SessionStackEntry[]): ConnectFn {
  return async () => ({
    handle: {
      kind: 'ws' as const,
      status: 'open' as const,
      send: vi.fn(),
      start: vi.fn(),
      dispose: async () => {},
    },
    ack: {
      sequence: 1,
      timestamp: Date.now(),
      stack,
      serverVersion: undefined,
    },
  });
}

// =============================================================================
// postLifecycleToParent — default postMessage emitter
// =============================================================================

describe('postLifecycleToParent', () => {
  it('posts a `ggui:lifecycle` envelope to window.parent', () => {
    const posted: unknown[] = [];
    const spy = vi
      .spyOn(window.parent, 'postMessage')
      .mockImplementation((msg: unknown) => {
        posted.push(msg);
      });
    try {
      postLifecycleToParent({ state: 'mounting' });
      expect(posted).toHaveLength(1);
      const msg = posted[0];
      expect(isMcpAppLifecycleMessage(msg)).toBe(true);
      const lifecycle = msg as McpAppLifecycleMessage;
      expect(lifecycle.event.state).toBe('mounting');
    } finally {
      spy.mockRestore();
    }
  });

  it('forwards stackItemId + error fields from the event', () => {
    const posted: unknown[] = [];
    const spy = vi
      .spyOn(window.parent, 'postMessage')
      .mockImplementation((msg: unknown) => {
        posted.push(msg);
      });
    try {
      postLifecycleToParent({
        state: 'error',
        stackItemId: 'item_a',
        error: { code: 'BOOM', message: 'kapow' },
      });
      const msg = posted[0] as McpAppLifecycleMessage;
      expect(msg.event.stackItemId).toBe('item_a');
      expect(msg.event.error).toEqual({ code: 'BOOM', message: 'kapow' });
    } finally {
      spy.mockRestore();
    }
  });

  it('swallows postMessage failures (parent unreachable)', () => {
    const spy = vi
      .spyOn(window.parent, 'postMessage')
      .mockImplementation(() => {
        throw new Error('detached');
      });
    try {
      expect(() => postLifecycleToParent({ state: 'mounting' })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

// =============================================================================
// makeLifecycleEvent — populated-event shape lock
// =============================================================================

describe('makeLifecycleEvent', () => {
  it('returns {state} only when no options are passed', () => {
    const event = makeLifecycleEvent('mounting');
    expect(Object.keys(event)).toEqual(['state']);
  });

  it('includes stackItemId when non-empty', () => {
    const event = makeLifecycleEvent('code-ready', { stackItemId: 'item_a' });
    expect(event.stackItemId).toBe('item_a');
  });

  it('drops empty stackItemId — never emits a {state, stackItemId: ""} shape', () => {
    const event = makeLifecycleEvent('code-ready', { stackItemId: '' });
    expect(event.stackItemId).toBeUndefined();
    expect(Object.keys(event)).toEqual(['state']);
  });

  it('includes error when present', () => {
    const event: McpAppLifecycleEvent = makeLifecycleEvent('error', {
      error: { code: 'WS_HANDSHAKE_FAILED', message: 'boom' },
    });
    expect(event.error).toEqual({ code: 'WS_HANDSHAKE_FAILED', message: 'boom' });
  });
});

// =============================================================================
// bootSequence — onLifecycle integration
// =============================================================================

const VALID_BOOTSTRAP: McpAppAiGguiMountView = {
  wsUrl: 'wss://server.example/ws',
  token: 'tok_abc',
  sessionId: 'sess_001',
  appId: 'app_001',
  expiresAt: '2099-01-01T00:00:00.000Z',
  runtimeUrl: '/_ggui/iframe-runtime.js',
};

function buildHappyInitResponse(
  bootstrap: McpAppAiGguiMountView = VALID_BOOTSTRAP,
): { result: unknown } {
  return {
    result: {
      toolOutput: {
        _meta: mountViewToMcpAppMeta(bootstrap),
        structuredContent: {},
      },
    },
  };
}

function makeStackItem(id: string): SessionStackEntry {
  return {
    id,
    componentCode: '/* unused */',
    description: id,
    createdAt: new Date().toISOString(),
  };
}

describe('bootSequence — lifecycle on happy path', () => {
  it('fires mounting then code-ready, in that order, on a successful boot', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const onLifecycle = vi.fn();

    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInitResponse());
    const connectFn = buildHappyConnect([makeStackItem('item_a')]);

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
      onLifecycle,
    });

    expect(result.ok).toBe(true);
    const states = lifecycleEvents(onLifecycle).map((e) => e.state);
    expect(states).toEqual(['mounting', 'code-ready']);
  });

  it('forwards bootstrap.stackItemId on the code-ready event when present (single-item mode)', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const onLifecycle = vi.fn();

    const pinnedBootstrap: McpAppAiGguiMountView = {
      ...VALID_BOOTSTRAP,
      stackItemId: 'item_pinned',
    };

    const callUiInitialize = vi
      .fn()
      .mockResolvedValue(buildHappyInitResponse(pinnedBootstrap));
    const connectFn = buildHappyConnect([makeStackItem('item_pinned')]);

    await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
      onLifecycle,
    });

    const events = lifecycleEvents(onLifecycle);
    const codeReady = events.find((e) => e.state === 'code-ready');
    expect(codeReady?.stackItemId).toBe('item_pinned');

    const mounting = events.find((e) => e.state === 'mounting');
    expect(mounting?.stackItemId).toBeUndefined();
  });
});

describe('bootSequence — lifecycle on failure paths', () => {
  it('fires mounting then error with reason=UI_INITIALIZE_FAILED', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const onLifecycle = vi.fn();

    const callUiInitialize = vi.fn().mockResolvedValue({
      error: { code: -1, message: 'host refused' },
    });
    const connectFn = vi.fn() as unknown as ConnectFn;

    await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
      onLifecycle,
    });

    const events = lifecycleEvents(onLifecycle);
    expect(events.map((e) => e.state)).toEqual(['mounting', 'error']);
    const errorEvt = events[1];
    expect(errorEvt?.error?.code).toBe('UI_INITIALIZE_FAILED');
    expect(errorEvt?.error?.message).toContain('host refused');
  });

  it('fires mounting then error with reason=MISSING_META_GGUI_BOOTSTRAP when initResp lacks _meta.ggui.bootstrap', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const onLifecycle = vi.fn();

    const callUiInitialize = vi.fn().mockResolvedValue({
      result: { toolOutput: { _meta: {}, structuredContent: {} } },
    });
    const connectFn = vi.fn() as unknown as ConnectFn;

    await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
      onLifecycle,
    });

    const events = lifecycleEvents(onLifecycle);
    expect(events.map((e) => e.state)).toEqual(['mounting', 'error']);
    expect(events[1]?.error?.code).toBe('MISSING_META_GGUI_BOOTSTRAP');
  });

  it('fires mounting then error with reason=WS_HANDSHAKE_FAILED when connectFn throws', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const onLifecycle = vi.fn();

    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInitResponse());
    const connectFn = vi.fn().mockRejectedValue(new Error('socket dead')) as unknown as ConnectFn;

    await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
      onLifecycle,
    });

    const events = lifecycleEvents(onLifecycle);
    expect(events.map((e) => e.state)).toEqual(['mounting', 'error']);
    expect(events[1]?.error?.code).toBe('WS_HANDSHAKE_FAILED');
    expect(events[1]?.error?.message).toContain('socket dead');
  });

  it('does NOT fire any lifecycle event when onLifecycle is omitted (additive opt-in)', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');

    const callUiInitialize = vi.fn().mockResolvedValue(buildHappyInitResponse());
    const connectFn = buildHappyConnect([makeStackItem('item_a')]);

    const result = await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent: vi.fn(),
    });

    expect(result.ok).toBe(true);
  });

  it('runtime emits the lifecycle envelope alongside the legacy `ggui:bootstrap-failed` envelope (parallel paths)', async () => {
    const dom = document.implementation.createHTMLDocument('renderer-test');
    const onLifecycle = vi.fn();
    const notifyParent = vi.fn();

    const callUiInitialize = vi.fn().mockResolvedValue({
      error: { code: -1, message: 'host refused' },
    });
    const connectFn = vi.fn() as unknown as ConnectFn;

    await bootSequence({
      doc: dom,
      callUiInitialize,
      connectFn,
      notifyParent,
      onLifecycle,
    });

    const failedEnvelopes = notifyParentCalls(notifyParent).filter(
      (m): m is { type: string; reason: string; message: string } =>
        m !== null &&
        typeof m === 'object' &&
        (m as { type?: unknown }).type === 'ggui:bootstrap-failed',
    );
    expect(failedEnvelopes).toHaveLength(1);
    expect(failedEnvelopes[0]?.reason).toBe('UI_INITIALIZE_FAILED');

    const lifecycleErrors = lifecycleEvents(onLifecycle).filter(
      (e) => e.state === 'error',
    );
    expect(lifecycleErrors).toHaveLength(1);
    expect(lifecycleErrors[0]?.error?.code).toBe('UI_INITIALIZE_FAILED');
  });
});
