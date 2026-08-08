/**
 * Observability emission — C12 unit tests.
 *
 * Covers both renderer-side emission points:
 *
 *   1. `schema-version-mismatch` — fires from `connectViaRegistry`'s
 *      UPGRADE_REQUIRED branches (client-side ack mismatch + server
 *      pre-ack error frame).
 *   2. `subscribe-failed` — fires from `connectViaRegistry`'s wrapped
 *      `onStatusChange` whenever the transport transitions to
 *      `reconnecting`.
 *
 * Post-B3b the runtime no longer fans frames through a separate
 * `onMessage` callback — frames flow through the channel-registry's
 * registered handlers. Tests therefore drive observability emission
 * through the connectFn seam: inject a mock transport that emits
 * frames through the registry's handlers post-bind.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CLIENT_SUPPORTED_VERSIONS,
  UPGRADE_REQUIRED,
} from '@ggui-ai/protocol/version';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { ChannelRegistry } from '@ggui-ai/live-channel';
import {
  postObservabilityToParent,
  type ObservabilityEvent,
  type ObservabilityMessage,
} from '../observability.js';
import { connectViaRegistry } from '../registry-subscribe.js';

// =============================================================================
// postObservabilityToParent — default postMessage emitter
// =============================================================================

describe('postObservabilityToParent', () => {
  it('posts an `ggui:observe` envelope to window.parent', () => {
    const posted: unknown[] = [];
    const originalPost = window.parent.postMessage.bind(window.parent);
    const spy = vi
      .spyOn(window.parent, 'postMessage')
      .mockImplementation((msg: unknown, _target: unknown) => {
        posted.push(msg);
      });
    try {
      const event: ObservabilityEvent = {
        kind: 'subscribe-failed',
        reason: 'unit-test',
      };
      postObservabilityToParent(event);
      expect(posted).toHaveLength(1);
      const msg = posted[0] as ObservabilityMessage;
      expect(msg.type).toBe('ggui:observe');
      expect(msg.event).toEqual(event);
    } finally {
      spy.mockRestore();
      void originalPost;
    }
  });

  it('swallows postMessage failures silently (detached parent)', () => {
    const spy = vi
      .spyOn(window.parent, 'postMessage')
      .mockImplementation(() => {
        throw new Error('parent detached');
      });
    try {
      expect(() =>
        postObservabilityToParent({
          kind: 'subscribe-failed',
          reason: 'detach-test',
        }),
      ).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

// =============================================================================
// MockWebSocket — shared with the version-handshake + subscribe-failed tests
// =============================================================================

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: ((event?: { code?: number }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  readonly sent: string[] = [];

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
    setTimeout(() => {
      this.readyState = MockWebSocket.OPEN;
      this.onopen?.();
    }, 0);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  static reset(): void {
    MockWebSocket.instances = [];
  }
}

const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  MockWebSocket.reset();
  vi.useFakeTimers();
  globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.WebSocket = originalWebSocket;
});

function renderMeta(): McpAppAiGguiRenderMeta {
  return {
    sessionId: 'render-c12',
    appId: 'app-c12',
    wsUrl: 'wss://test.invalid/ws',
    wsToken: 'boot-token',
    expiresAt: '2099-01-01T00:00:00.000Z',
    runtimeUrl: '/_ggui/iframe-runtime.js',
  };
}

function makeRegistry(meta: McpAppAiGguiRenderMeta): ChannelRegistry {
  return new ChannelRegistry({
    subscribeFrameBuilder: () => ({
      type: 'subscribe',
      payload: {
        sessionId: meta.sessionId,
        appId: meta.appId,
        bootstrap: meta.wsToken,
        supportedVersions: [...CLIENT_SUPPORTED_VERSIONS],
      },
    }),
  });
}

// =============================================================================
// connectViaRegistry — schema-version-mismatch emission
// =============================================================================

describe('connectViaRegistry — schema-version-mismatch emission', () => {
  it('emits observedBy=server when the pre-ack error frame is UPGRADE_REQUIRED', async () => {
    const observed: ObservabilityEvent[] = [];
    const promise = connectViaRegistry({
      meta: renderMeta(),
      registry: makeRegistry(renderMeta()),
      onStatusChange: () => {},
      onObserve: (e) => observed.push(e),
    });

    await vi.advanceTimersByTimeAsync(0);
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();
    ws?.onmessage?.({
      data: JSON.stringify({
        type: 'error',
        payload: {
          code: UPGRADE_REQUIRED,
          message: 'client too old',
          details: { serverVersion: '99.0.0' },
        },
      }),
    });
    await expect(promise).rejects.toMatchObject({
      code: UPGRADE_REQUIRED,
    });
    const mismatch = observed.find(
      (e): e is Extract<ObservabilityEvent, { kind: 'schema-version-mismatch' }> =>
        e.kind === 'schema-version-mismatch',
    );
    expect(mismatch).toBeDefined();
    if (mismatch === undefined) return;
    expect(mismatch.observedBy).toBe('server');
    expect(mismatch.observedVersion).toBe('99.0.0');
    expect(mismatch.acceptedVersions).toEqual(CLIENT_SUPPORTED_VERSIONS);
  });

  it('emits observedBy=client when the ack advertises an unaccepted serverVersion', async () => {
    const observed: ObservabilityEvent[] = [];
    const promise = connectViaRegistry({
      meta: renderMeta(),
      registry: makeRegistry(renderMeta()),
      onStatusChange: () => {},
      onObserve: (e) => observed.push(e),
    });

    await vi.advanceTimersByTimeAsync(0);
    const ws = MockWebSocket.instances[0];
    ws?.onmessage?.({
      data: JSON.stringify({
        type: 'ack',
        payload: {
          sessionToken: 't',
          serverVersion: '999.0.0',
        },
      }),
    });
    await expect(promise).rejects.toThrow();
    const mismatch = observed.find(
      (e): e is Extract<ObservabilityEvent, { kind: 'schema-version-mismatch' }> =>
        e.kind === 'schema-version-mismatch',
    );
    expect(mismatch).toBeDefined();
    if (mismatch === undefined) return;
    expect(mismatch.observedBy).toBe('client');
    expect(mismatch.observedVersion).toBe('999.0.0');
    expect(mismatch.acceptedVersions).toEqual(CLIENT_SUPPORTED_VERSIONS);
  });
});

// =============================================================================
// connectViaRegistry — subscribe-failed emission
// =============================================================================

describe('connectViaRegistry — subscribe-failed emission', () => {
  it('emits subscribe-failed when the status transitions to reconnecting after a prior open', async () => {
    const observed: ObservabilityEvent[] = [];
    const statuses: string[] = [];
    const promise = connectViaRegistry({
      meta: renderMeta(),
      registry: makeRegistry(renderMeta()),
      onStatusChange: (s) => statuses.push(s),
      onObserve: (e) => observed.push(e),
    });

    // Advance to trigger the socket open + ack handlers being
    // registered. The transport's first `connecting` is mapped to
    // protocol-level `connecting`; only AFTER a prior `open` does a
    // second `connecting` become `reconnecting`.
    await vi.advanceTimersByTimeAsync(0);
    const ws = MockWebSocket.instances[0];
    expect(ws).toBeDefined();

    // First drop AFTER open → reconnect ladder fires another connecting
    // transition, which maps to `reconnecting`.
    ws?.close();
    // The transport schedules a setTimeout for the next reconnect;
    // advance to the start() call which triggers the second `connecting`.
    await vi.advanceTimersByTimeAsync(1100);

    expect(statuses).toContain('reconnecting');
    const subFailed = observed.find(
      (e): e is Extract<ObservabilityEvent, { kind: 'subscribe-failed' }> =>
        e.kind === 'subscribe-failed',
    );
    expect(subFailed).toBeDefined();
    if (subFailed === undefined) return;
    expect(subFailed.reason).toBe('transport-reconnecting');
    expect(typeof subFailed.message).toBe('string');

    // Tear down — close all instances to stop the reconnect ladder.
    MockWebSocket.instances.forEach((i) => i.close());
    await vi.runOnlyPendingTimersAsync().catch(() => {});
    void promise;
  });
});
