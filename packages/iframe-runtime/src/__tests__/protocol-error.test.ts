/**
 * Runtime tests for `ProtocolError` emission.
 *
 * Covers the four C7c emission sites (B3b-updated):
 *
 *   1. `buildRootWireConfig` — client-side contract violations are
 *      mapped to `{kind: 'protocol'; code: 'CLIENT_CONTRACT_VIOLATION'}`
 *      and surfaced on `onProtocolError`.
 *
 *   2. `connectViaRegistry` — pre-ack `error` frames:
 *        - UPGRADE_REQUIRED → `{kind: 'version'}`
 *        - RENDER_NOT_FOUND / AUTH_REJECTED → `{kind: 'auth'}`
 *        - other → `{kind: 'protocol'}` with extensibly-closed code
 *      plus client-side version mismatch on the first ack.
 *
 *   3. `bootSequence` — every bootstrap failure emits both the legacy
 *      `RendererBootFailedMessage` and the typed `{kind: 'bootstrap'}`.
 *
 *   4. `protocol-error.ts` constructors — constructors produce the
 *      expected shape.
 *
 * The tests DO NOT spin up a real WS — they mock at the renderer's
 * public seams (`connectFn`, `notifyParent`, manager stub) or invoke
 * `connectViaRegistry` against a MockWebSocket for the typed-emission
 * branches.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CLIENT_SUPPORTED_VERSIONS,
  UPGRADE_REQUIRED,
} from '@ggui-ai/protocol/version';
import type {
  ConnectionStatus,
  WebSocketMessage,
} from '@ggui-ai/protocol/transport/websocket';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { GguiSession } from '@ggui-ai/protocol';
import { ChannelRegistry } from '@ggui-ai/live-channel';
import {
  ClientContractViolationError,
} from '@ggui-ai/wire';
import {
  buildRootWireConfig,
  StreamBus,
} from '../wire-config.js';
import { connectViaRegistry, type ConnectFn } from '../registry-subscribe.js';
import { bootSequence } from '../runtime.js';
import { buildBootHarness } from './boot-helpers.js';
import {
  defaultProtocolErrorEmitter,
  fromBootstrapFailure,
  fromClientContractViolation,
  fromAuthFailure,
  fromTransportFailure,
  fromUpgradeRequired,
  fromUnknown,
  type ProtocolError,
} from '../protocol-error.js';

// =============================================================================
// (4) Constructors — verify the mapped shapes
// =============================================================================

describe('protocol-error constructors', () => {
  it('fromBootstrapFailure surfaces both reason + message on kind=bootstrap', () => {
    const err = fromBootstrapFailure('MISSING_TOOL_OUTPUT', 'no tool output');
    expect(err).toEqual({
      kind: 'bootstrap',
      reason: 'MISSING_TOOL_OUTPUT',
      message: 'no tool output',
    });
  });

  it('fromClientContractViolation maps wire class → kind=protocol + CLIENT_CONTRACT_VIOLATION', () => {
    const cv = new ClientContractViolationError('outbound-action', [
      { field: 'email', message: 'required' },
    ]);
    const err = fromClientContractViolation(cv);
    expect(err.kind).toBe('protocol');
    if (err.kind !== 'protocol') throw new Error('unreachable');
    expect(err.code).toBe('CLIENT_CONTRACT_VIOLATION');
    expect(err.message).toBe(cv.message);
    expect(err.details).toEqual({
      direction: 'outbound-action',
      violations: cv.violations,
    });
  });

  it('fromTransportFailure preserves retryable flag', () => {
    const err = fromTransportFailure('DISCONNECTED', true, 'socket closed');
    expect(err).toEqual({
      kind: 'transport',
      code: 'DISCONNECTED',
      retryable: true,
      message: 'socket closed',
    });

    const terminal = fromTransportFailure('TIMEOUT', false);
    expect(terminal).toEqual({
      kind: 'transport',
      code: 'TIMEOUT',
      retryable: false,
    });
  });

  it('fromAuthFailure maps each auth code without leaking foreign codes', () => {
    expect(fromAuthFailure('RENDER_NOT_FOUND', 'gone')).toEqual({
      kind: 'auth',
      code: 'RENDER_NOT_FOUND',
      message: 'gone',
    });
    expect(fromAuthFailure('TOKEN_EXPIRED')).toEqual({
      kind: 'auth',
      code: 'TOKEN_EXPIRED',
    });
    expect(fromAuthFailure('AUTH_REJECTED')).toEqual({
      kind: 'auth',
      code: 'AUTH_REJECTED',
    });
  });

  it('fromUpgradeRequired flattens observedVersion array to comma string', () => {
    const single = fromUpgradeRequired({
      observedVersion: '3.0.0',
      acceptedVersions: ['1.0.0'],
      message: 'upgrade required',
    });
    expect(single).toEqual({
      kind: 'version',
      serverVersion: '3.0.0',
      clientSupports: ['1.0.0'],
      message: 'upgrade required',
    });

    const many = fromUpgradeRequired({
      observedVersion: ['3.0.0', '3.1.0'],
      acceptedVersions: ['1.0.0'],
      message: 'upgrade required',
    });
    expect(many.kind).toBe('version');
    if (many.kind !== 'version') throw new Error('unreachable');
    expect(many.serverVersion).toBe('3.0.0, 3.1.0');

    const missing = fromUpgradeRequired({
      acceptedVersions: ['1.0.0'],
      message: 'upgrade required',
    });
    expect(missing.kind).toBe('version');
    if (missing.kind !== 'version') throw new Error('unreachable');
    expect(missing.serverVersion).toBeUndefined();
  });

  it('fromUnknown wraps any value on kind=unknown', () => {
    expect(fromUnknown({ weird: 1 })).toEqual({ kind: 'unknown', raw: { weird: 1 } });
    expect(fromUnknown(null)).toEqual({ kind: 'unknown', raw: null });
  });

  it('defaultProtocolErrorEmitter writes to console.warn with a grep tag', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    defaultProtocolErrorEmitter(fromUnknown('x'));
    expect(spy).toHaveBeenCalledWith('[ggui:protocol-error]', { kind: 'unknown', raw: 'x' });
    spy.mockRestore();
  });
});

// =============================================================================
// (1) buildRootWireConfig — client-contract violations → onProtocolError
// =============================================================================

function makeRender(id: string, overrides: Partial<GguiSession> = {}): GguiSession {
  return {
    id,
    appId: 'app_x',
    componentCode: '/* unused */',
    description: `render ${id}`,
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    ...overrides,
  } as GguiSession;
}

function makeFakeManager(): { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn() };
}

describe('buildRootWireConfig — onProtocolError', () => {
  it('routes outbound-action violations through onProtocolError as kind=protocol', () => {
    const { send } = makeFakeManager();
    const actionSpec = {
      submit: {
        label: 'Submit',
        schema: {
          type: 'object' as const,
          required: ['email'],
          properties: { email: { type: 'string' as const } },
        },
      },
    };
    const render = makeRender('render_001', { actionSpec });
    const onProtocolError = vi.fn<(err: ProtocolError) => void>();
    const cfg = buildRootWireConfig({
      renderId: 'render_001',
      appId: 'a1',
      getCurrentGguiSession: () => render,
      manager: { send },
      streamBus: new StreamBus(),
      onProtocolError,
    });

    cfg.dispatch('submit', {});

    expect(send).not.toHaveBeenCalled();
    expect(onProtocolError).toHaveBeenCalledTimes(1);
    const [emitted] = onProtocolError.mock.calls[0] as [ProtocolError];
    expect(emitted.kind).toBe('protocol');
    if (emitted.kind !== 'protocol') throw new Error('unreachable');
    expect(emitted.code).toBe('CLIENT_CONTRACT_VIOLATION');
    expect(emitted.details).toMatchObject({ direction: 'outbound-action' });
  });

  it('falls back to console.warn when no handler supplied', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { send } = makeFakeManager();
    const actionSpec = {
      submit: {
        label: 'Submit',
        schema: {
          type: 'object' as const,
          required: ['email'],
          properties: { email: { type: 'string' as const } },
        },
      },
    };
    const render = makeRender('render_001', { actionSpec });
    const cfg = buildRootWireConfig({
      renderId: 'render_001',
      appId: 'a1',
      getCurrentGguiSession: () => render,
      manager: { send },
      streamBus: new StreamBus(),
    });

    cfg.dispatch('submit', {});

    expect(send).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalledWith(expect.stringMatching(/^\[ggui:contract\]/), expect.any(Object));
    expect(spy).toHaveBeenCalledWith('[ggui:protocol-error]', expect.objectContaining({ kind: 'protocol' }));
    spy.mockRestore();
  });
});

// =============================================================================
// (2) connectViaRegistry — typed emission on pre-ack errors + version mismatch
// =============================================================================

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
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
  simulateMessage(msg: WebSocketMessage): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
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

describe('connectViaRegistry — onProtocolError', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  });

  function meta(): McpAppAiGguiRenderMeta {
    return {
      wsUrl: 'ws://test/ws',
      renderId: 'render_001',
      appId: 'app_x',
      wsToken: 'bootstrap_token',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      runtimeUrl: '/_ggui/iframe-runtime.js',
    };
  }

  it('emits kind=version on UPGRADE_REQUIRED error frame + rejects', async () => {
    const emitted: ProtocolError[] = [];
    const promise = connectViaRegistry({
      meta: meta(),
      registry: makeRegistry(meta()),
      onStatusChange: (_s: ConnectionStatus) => {},
      onProtocolError: (e) => emitted.push(e),
    });

    await vi.advanceTimersByTimeAsync(10);
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error('no ws');
    ws.simulateMessage({
      type: 'error',
      payload: {
        code: UPGRADE_REQUIRED,
        message: 'upgrade',
        details: { serverVersion: '99.0.0' },
      },
    });

    await expect(promise).rejects.toMatchObject({ name: 'UpgradeRequiredError' });
    const versionErr = emitted.find((e) => e.kind === 'version');
    expect(versionErr).toBeDefined();
    if (!versionErr || versionErr.kind !== 'version') throw new Error('unreachable');
    expect(versionErr.serverVersion).toBe('99.0.0');
    expect(versionErr.clientSupports).toEqual(CLIENT_SUPPORTED_VERSIONS);
  });

  it('emits kind=auth on RENDER_NOT_FOUND error frame', async () => {
    const emitted: ProtocolError[] = [];
    const promise = connectViaRegistry({
      meta: meta(),
      registry: makeRegistry(meta()),
      onStatusChange: () => {},
      onProtocolError: (e) => emitted.push(e),
    });

    await vi.advanceTimersByTimeAsync(10);
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error('no ws');
    ws.simulateMessage({
      type: 'error',
      payload: {
        code: 'RENDER_NOT_FOUND',
        message: 'no render',
      },
    });

    await expect(promise).rejects.toThrow('no render');
    const authErr = emitted.find((e) => e.kind === 'auth');
    expect(authErr).toBeDefined();
    if (!authErr || authErr.kind !== 'auth') throw new Error('unreachable');
    expect(authErr.code).toBe('RENDER_NOT_FOUND');
  });

  it('emits kind=protocol on unknown error code with extensibly-closed forwarding', async () => {
    const emitted: ProtocolError[] = [];
    const promise = connectViaRegistry({
      meta: meta(),
      registry: makeRegistry(meta()),
      onStatusChange: () => {},
      onProtocolError: (e) => emitted.push(e),
    });

    await vi.advanceTimersByTimeAsync(10);
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error('no ws');
    ws.simulateMessage({
      type: 'error',
      payload: {
        code: 'FORWARD_COMPAT_CODE',
        message: 'unknown to client',
        details: { when: 'pre-ack' },
      },
    });

    await expect(promise).rejects.toThrow('unknown to client');
    const protoErr = emitted.find((e) => e.kind === 'protocol');
    expect(protoErr).toBeDefined();
    if (!protoErr || protoErr.kind !== 'protocol') throw new Error('unreachable');
    expect(protoErr.code).toBe('FORWARD_COMPAT_CODE');
    expect(protoErr.details).toEqual({ when: 'pre-ack' });
  });

  it('emits kind=version when client rejects ack.serverVersion mismatch', async () => {
    const emitted: ProtocolError[] = [];
    const promise = connectViaRegistry({
      meta: meta(),
      registry: makeRegistry(meta()),
      onStatusChange: () => {},
      onProtocolError: (e) => emitted.push(e),
    });

    await vi.advanceTimersByTimeAsync(10);
    const ws = MockWebSocket.instances[0];
    if (!ws) throw new Error('no ws');
    ws.simulateMessage({
      type: 'ack',
      payload: {
        sequence: 0,
        timestamp: Date.now(),
        serverVersion: '99.0.0',
      },
    });

    await expect(promise).rejects.toMatchObject({ name: 'UpgradeRequiredError' });
    const versionErr = emitted.find((e) => e.kind === 'version');
    expect(versionErr).toBeDefined();
    if (!versionErr || versionErr.kind !== 'version') throw new Error('unreachable');
    expect(versionErr.serverVersion).toBe('99.0.0');
  });
});

// =============================================================================
// (3) bootSequence — bootstrap-failure dual emission
// =============================================================================

describe('bootSequence — onProtocolError dual emission', () => {
  it('emits kind=bootstrap + reason=UI_INITIALIZE_FAILED when App.connect rejects', async () => {
    const doc = document.implementation.createHTMLDocument('boot');
    const notifyParent = vi.fn();
    const onProtocolError = vi.fn<(err: ProtocolError) => void>();
    const connectFn = vi.fn() as unknown as ConnectFn;
    const { app, transport } = buildBootHarness({
      initResponse: { error: { message: 'host refused' } },
    });
    await bootSequence({
      doc,
      app,
      transport,
      connectFn,
      notifyParent,
      onProtocolError,
      toolResultTimeoutMs: 50,
    });
    expect(notifyParent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ggui:bootstrap-failed',
      reason: 'UI_INITIALIZE_FAILED',
    }));
    expect(onProtocolError).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'bootstrap',
      reason: 'UI_INITIALIZE_FAILED',
    }));
  });

  it('emits kind=bootstrap + reason=MISSING_META_GGUI_BOOTSTRAP when no slice meta arrives', async () => {
    const doc = document.implementation.createHTMLDocument('boot');
    const notifyParent = vi.fn();
    const onProtocolError = vi.fn<(err: ProtocolError) => void>();
    const connectFn = vi.fn() as unknown as ConnectFn;
    const { app, transport } = buildBootHarness();
    await bootSequence({
      doc,
      app,
      transport,
      connectFn,
      notifyParent,
      onProtocolError,
      toolResultTimeoutMs: 50,
    });
    const emittedReasons = onProtocolError.mock.calls
      .map(([err]) => err)
      .filter((e): e is ProtocolError & { kind: 'bootstrap' } => e.kind === 'bootstrap');
    expect(emittedReasons.length).toBeGreaterThanOrEqual(1);
    expect(emittedReasons[0]?.reason).toBe('MISSING_META_GGUI_BOOTSTRAP');
  });

  it('does not emit ProtocolError when onProtocolError absent (legacy callers)', async () => {
    const doc = document.implementation.createHTMLDocument('boot');
    const notifyParent = vi.fn();
    const connectFn = vi.fn() as unknown as ConnectFn;
    const { app, transport } = buildBootHarness({
      initResponse: { error: { message: 'host refused' } },
    });
    await bootSequence({
      doc,
      app,
      transport,
      connectFn,
      notifyParent,
      toolResultTimeoutMs: 50,
    });
    expect(notifyParent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'ggui:bootstrap-failed',
      reason: 'UI_INITIALIZE_FAILED',
    }));
  });
});
