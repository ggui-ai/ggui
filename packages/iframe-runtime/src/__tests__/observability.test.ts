/**
 * Observability emission — C12 + Wave 3 §S2 unit tests.
 *
 * Covers each of the five renderer-side emission points:
 *
 *   1. `wired-tool-invoked` — fires from the wire config's outbound
 *      dispatch whenever a `data:submit` envelope resolves to a tool.
 *   2. `contract-error-emitted` — fires from the data channel handler
 *      when a `_ggui:contract-error` envelope arrives on the live channel.
 *   3. `schema-version-mismatch` — fires from `connectViaRegistry`'s
 *      UPGRADE_REQUIRED branches (client-side ack mismatch + server
 *      pre-ack error frame).
 *   4. `subscribe-failed` — fires from `connectViaRegistry`'s wrapped
 *      `onStatusChange` whenever the transport transitions to
 *      `reconnecting`.
 *   5. `auth-required` (Wave 3 §S2) — fires from the system channel
 *      handler when a `system` frame arrives with
 *      `action: 'auth_required'` and a usable `consentUrl`.
 *
 * Post-B3b the runtime no longer fans frames through a separate
 * `onMessage` callback — frames flow through the channel-registry's
 * registered handlers. Tests therefore drive observability emission
 * by:
 *   - For `connectViaRegistry`-owned emissions: use the connectFn
 *     seam to inject a mock transport that emits frames through the
 *     registry's handlers post-bind.
 *   - For `data` + `system` channel emissions: invoke the channel
 *     handlers directly with the test payload.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CLIENT_SUPPORTED_VERSIONS,
  UPGRADE_REQUIRED,
} from '@ggui-ai/protocol/version';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { ChannelRegistry } from '@ggui-ai/live-channel';
import {
  postObservabilityToParent,
  type ObservabilityEvent,
  type ObservabilityMessage,
} from '../observability.js';
import { connectViaRegistry } from '../registry-subscribe.js';
import { buildRootWireConfig } from '../wire-config.js';
import {
  createDataHandler,
  createSystemHandler,
} from '../channels/index.js';
import { mergeReservedValidators } from '../validation.js';
import { StreamBus } from '../wire-config.js';
import type { ActionSpec, Render } from '@ggui-ai/protocol';

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
// wire-config dispatch — `wired-tool-invoked`
// =============================================================================

describe('buildRootWireConfig — wired-tool-invoked emission', () => {
  it('emits a wired-tool-invoked event when a dispatched action resolves to a tool', () => {
    const observed: ObservabilityEvent[] = [];
    const sent: WebSocketMessage[] = [];
    const managerShim = { send: (m: WebSocketMessage) => sent.push(m) };
    const actionSpec: ActionSpec = {
      'tasks.create': {
        label: 'Create',
        nextStep: 'tasks.create_tool',
      },
    };
    const render: Render = {
      id: 'page-1',
      appId: 'app-1',
      componentCode: 'export default () => null',
      eventSequence: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      actionSpec,
    };
    const config = buildRootWireConfig({
      renderId: 'render-1',
      appId: 'app-1',
      getCurrentRender: () => render,
      manager: managerShim,
      streamBus: new (class {
        subscribe(): () => void {
          return () => {};
        }
        emit(): void {}
      })() as unknown as import('../wire-config.js').StreamBus,
      onObserve: (event) => observed.push(event),
    });

    config.dispatch('tasks.create', { title: 'hello' });

    expect(sent).toHaveLength(1);
    expect(observed).toHaveLength(1);
    const wired = observed.find(
      (e): e is Extract<ObservabilityEvent, { kind: 'wired-tool-invoked' }> =>
        e.kind === 'wired-tool-invoked',
    );
    expect(wired).toBeDefined();
    if (wired === undefined) return;
    expect(wired.toolName).toBe('tasks.create_tool');
    expect(wired.actionName).toBe('tasks.create');
    expect(typeof wired.dispatchedAt).toBe('string');
    expect(Number.isNaN(Date.parse(wired.dispatchedAt))).toBe(false);
  });

  it('does NOT emit when the dispatched action has no tool binding', () => {
    const observed: ObservabilityEvent[] = [];
    const sent: WebSocketMessage[] = [];
    const render: Render = {
      id: 'page-agent',
      appId: 'app-agent',
      componentCode: 'export default () => null',
      eventSequence: 0,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      expiresAt: Date.now() + 60_000,
      actionSpec: {
        'plain.action': { label: 'Plain' /* agent-routed, no tool */ },
      },
    };
    const config = buildRootWireConfig({
      renderId: 'render-agent',
      appId: 'app-agent',
      getCurrentRender: () => render,
      manager: { send: (m) => sent.push(m) },
      streamBus: new (class {
        subscribe(): () => void {
          return () => {};
        }
        emit(): void {}
      })() as unknown as import('../wire-config.js').StreamBus,
      onObserve: (event) => observed.push(event),
    });

    config.dispatch('plain.action', { foo: 1 });

    expect(sent).toHaveLength(1);
    expect(observed).toHaveLength(0);
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
    renderId: 'render-c12',
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
        renderId: meta.renderId,
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
          stack: [],
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
// data channel handler — contract-error-emitted emission
// =============================================================================

describe('data handler — contract-error-emitted emission', () => {
  it('emits contract-error-emitted when a _ggui:contract-error envelope arrives', () => {
    const observed: ObservabilityEvent[] = [];
    // No mounted item — the validator won't enforce because there's
    // no active streamSpec. Behaviour matches a session whose item
    // hasn't declared a streamSpec entry for the inbound channel.
    const handler = createDataHandler({
      getCurrentRender: () => null,
      streamBus: new StreamBus(),
      validatorCtx: { reservedValidators: mergeReservedValidators(undefined, undefined) },
      onObserve: (e) => observed.push(e),
    });

    void handler.onMessage({
      renderId: 'render-c12-obs',
      channel: '_ggui:contract-error',
      mode: 'append',
      payload: {
        toolName: 'tasks.create_tool',
        actionName: 'tasks.create',
        error: {
          code: 'TOOL_THREW',
          message: 'boom',
        },
        timestamp: new Date().toISOString(),
      },
    });

    const event = observed.find(
      (e): e is Extract<ObservabilityEvent, { kind: 'contract-error-emitted' }> =>
        e.kind === 'contract-error-emitted',
    );
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.code).toBe('TOOL_THREW');
    expect(event.toolName).toBe('tasks.create_tool');
    expect(event.actionName).toBe('tasks.create');
  });

  it('skips emission on data envelopes for non-reserved channels', () => {
    const observed: ObservabilityEvent[] = [];
    const handler = createDataHandler({
      getCurrentRender: () => null,
      streamBus: new StreamBus(),
      validatorCtx: { reservedValidators: mergeReservedValidators(undefined, undefined) },
      onObserve: (e) => observed.push(e),
    });

    void handler.onMessage({
      renderId: 'render-skip',
      channel: 'tasks',
      mode: 'replace',
      payload: [{ id: 1 }],
    });

    expect(observed).toHaveLength(0);
  });
});

// =============================================================================
// system channel handler — auth-required emission (Wave 3 §S2)
// =============================================================================

describe('system handler — auth-required emission (Wave 3 §S2)', () => {
  it('emits auth-required with all optional hints when server supplies them', () => {
    const observed: ObservabilityEvent[] = [];
    const handler = createSystemHandler({ onObserve: (e) => observed.push(e) });

    void handler.onMessage({
      action: 'auth_required',
      serviceId: 'google',
      displayName: 'Google',
      scopes: ['https://www.googleapis.com/auth/calendar.readonly'],
      consentUrl: 'https://credentials.example.com/oauth/initiate?service=google',
      message: 'This agent needs access to your Google Calendar.',
      appId: 'app-s2-auth',
      renderId: 'render-s2-auth',
    });

    const event = observed.find(
      (e): e is Extract<ObservabilityEvent, { kind: 'auth-required' }> =>
        e.kind === 'auth-required',
    );
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.provider).toBe('google');
    expect(event.authUrl).toBe(
      'https://credentials.example.com/oauth/initiate?service=google',
    );
    expect(event.displayName).toBe('Google');
    expect(event.scopes).toEqual([
      'https://www.googleapis.com/auth/calendar.readonly',
    ]);
    expect(event.message).toBe(
      'This agent needs access to your Google Calendar.',
    );
  });

  it('emits auth-required with only required fields when hints are absent', () => {
    const observed: ObservabilityEvent[] = [];
    const handler = createSystemHandler({ onObserve: (e) => observed.push(e) });

    void handler.onMessage({
      action: 'auth_required',
      serviceId: 'slack',
      consentUrl: 'https://credentials.example.com/oauth/initiate?service=slack',
    });

    const event = observed.find(
      (e): e is Extract<ObservabilityEvent, { kind: 'auth-required' }> =>
        e.kind === 'auth-required',
    );
    expect(event).toBeDefined();
    if (event === undefined) return;
    expect(event.provider).toBe('slack');
    expect(event.authUrl).toBe(
      'https://credentials.example.com/oauth/initiate?service=slack',
    );
    expect('displayName' in event).toBe(false);
    expect('scopes' in event).toBe(false);
    expect('message' in event).toBe(false);
  });

  it('skips emission when the system frame has no consentUrl', () => {
    const observed: ObservabilityEvent[] = [];
    const handler = createSystemHandler({ onObserve: (e) => observed.push(e) });

    void handler.onMessage({
      action: 'auth_required',
      serviceId: 'google',
      displayName: 'Google',
    });

    expect(observed.filter((e) => e.kind === 'auth-required')).toHaveLength(0);
  });

  it('skips emission on system frames with a different action (e.g. credential_ready)', () => {
    const observed: ObservabilityEvent[] = [];
    const handler = createSystemHandler({ onObserve: (e) => observed.push(e) });

    void handler.onMessage({
      action: 'credential_ready',
      serviceId: 'google',
      status: 'active',
    });

    expect(observed.filter((e) => e.kind === 'auth-required')).toHaveLength(0);
  });

  it('does not emit contract-error-emitted on a system frame', () => {
    const observed: ObservabilityEvent[] = [];
    const handler = createSystemHandler({ onObserve: (e) => observed.push(e) });

    void handler.onMessage({
      action: 'auth_required',
      serviceId: 'google',
      consentUrl: 'https://credentials.example.com/oauth/initiate?service=google',
    });

    expect(
      observed.filter((e) => e.kind === 'contract-error-emitted'),
    ).toHaveLength(0);
  });
});

// =============================================================================
// Union extensibility — auth-required arm is assignable via ObservabilityEmitter
// =============================================================================

describe('ObservabilityEvent — auth-required union arm', () => {
  it('accepts auth-required assignments through the ObservabilityEmitter type', () => {
    const observed: ObservabilityEvent[] = [];
    const emit: import('../observability.js').ObservabilityEmitter = (e) =>
      observed.push(e);
    emit({
      kind: 'auth-required',
      provider: 'google',
      authUrl: 'https://credentials.example.com/oauth/initiate?service=google',
    });
    emit({
      kind: 'auth-required',
      provider: 'slack',
      authUrl: 'https://credentials.example.com/oauth/initiate?service=slack',
      displayName: 'Slack',
      scopes: ['chat:write'],
      message: 'post to your workspace',
    });
    expect(observed).toHaveLength(2);
    const first = observed[0];
    const second = observed[1];
    expect(first?.kind).toBe('auth-required');
    expect(second?.kind).toBe('auth-required');
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
