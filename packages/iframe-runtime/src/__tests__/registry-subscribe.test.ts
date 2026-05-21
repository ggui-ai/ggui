/**
 * `connectViaRegistry` tests — cover the handshake-resolver pipeline
 * on top of `@ggui-ai/channel-client`'s `ChannelRegistry.bind()`.
 *
 * Replaces the pre-B3b `subscribe.test.ts`. The six behavioural
 * branches port verbatim — every test from the retired file has a
 * counterpart here:
 *
 *   1. Happy path: open WS, send subscribe with `supportedVersions`,
 *      resolve on first ack.
 *   2. Absent serverVersion = legacy pass-through (no upgrade error).
 *   3. UpgradeRequiredError on unknown serverVersion in ack.
 *   4. UpgradeRequiredError on pre-ack
 *      `{type:'error', code:'UPGRADE_REQUIRED'}`.
 *   5. Plain Error on non-upgrade pre-ack error (with typed protocol
 *      error emitted via onProtocolError).
 *   6. Post-resolution frames go to registered handlers, NOT to a
 *      callback. The registry's transport routes frames directly to
 *      the handler whose `type` matches.
 *
 * Strategy:
 *   - Mock WebSocket globally with a class that records every send +
 *     exposes `emit(message)` for driving open / message / error /
 *     close from the test body.
 *   - Build a fresh `ChannelRegistry` per test with the same
 *     subscribeFrameBuilder shape `runtime.ts` uses in production.
 *   - Call `connectViaRegistry({bootstrap, registry, ...})`, drive
 *     ack/error frames via the mock socket, assert on the resolved
 *     handle or rejected error.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CLIENT_SUPPORTED_VERSIONS,
  PROTOCOL_SCHEMA_VERSION,
  UPGRADE_REQUIRED,
} from '@ggui-ai/protocol/version';
import { UpgradeRequiredError } from '@ggui-ai/protocol/errors/version-mismatch';
import type {
  ConnectionStatus,
  WebSocketMessage,
} from '@ggui-ai/protocol/transport/websocket';
import type { GguiBootstrapMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { ChannelRegistry } from '@ggui-ai/channel-client';
import { connectViaRegistry } from '../registry-subscribe.js';
import type { ProtocolError } from '../protocol-error.js';

// =============================================================================
// MockWebSocket — same shape as the pre-B3b subscribe.test.ts mock,
// ports verbatim because the channel-client's WSTransport touches the
// same surface (constructor + readyState + on{open,close,message,error}
// + send/close + statics).
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
    // Async open mirrors real-WS behavior — test bodies advance timers
    // to trigger it.
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

  emit(message: WebSocketMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
}

function installMockWebSocket(): void {
  // @ts-expect-error - Mock WebSocket; mock surface matches the
  // transport's runtime-touched contract, not the full DOM type.
  global.WebSocket = MockWebSocket;
}

// `satisfies` keeps `wsUrl` / `token` narrowed to `string` so the
// composed-URL assertion below doesn't trip the optional discriminator.
const BOOTSTRAP = {
  wsUrl: 'wss://server.example/ws',
  token: 'tok_abc',
  sessionId: 'sess_001',
  appId: 'app_001',
  expiresAt: '2099-01-01T00:00:00.000Z',
  runtimeUrl: '/_ggui/iframe-runtime.js',
} satisfies GguiBootstrapMeta;

/**
 * Build a registry shaped like the one `runtime.ts` produces — same
 * subscribe-frame builder, no handlers pre-registered. Tests register
 * post-bind handlers if they want to assert frame delivery.
 */
function makeRegistry(): ChannelRegistry {
  return new ChannelRegistry({
    subscribeFrameBuilder: () => ({
      type: 'subscribe',
      payload: {
        sessionId: BOOTSTRAP.sessionId,
        appId: BOOTSTRAP.appId,
        bootstrap: BOOTSTRAP.token,
        supportedVersions: [...CLIENT_SUPPORTED_VERSIONS],
      },
    }),
  });
}

describe('connectViaRegistry — happy path', () => {
  let originalWs: typeof WebSocket;

  beforeEach(() => {
    originalWs = global.WebSocket;
    MockWebSocket.instances = [];
    installMockWebSocket();
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.WebSocket = originalWs;
    vi.useRealTimers();
  });

  it('opens the WS, sends subscribe with bootstrap + supportedVersions, resolves on ack', async () => {
    const statuses: ConnectionStatus[] = [];

    const handlePromise = connectViaRegistry({
      bootstrap: BOOTSTRAP,
      registry: makeRegistry(),
      onStatusChange: (s) => statuses.push(s),
    });

    await vi.advanceTimersByTimeAsync(1);

    expect(MockWebSocket.instances).toHaveLength(1);
    // The composed URL threads `bootstrap` as a query string.
    expect(MockWebSocket.instances[0]?.url).toBe(
      `wss://server.example/ws?bootstrap=${encodeURIComponent(BOOTSTRAP.token)}`,
    );

    // The channel-client transport initialises its currentStatus to
    // `'connecting'` and only emits transitions. `'open'` is the first
    // real transition the transport announces; `connectViaRegistry`
    // maps that to `'connected'` (mapping `connecting → connected` on
    // first open). The pre-bind `connecting` state is therefore not
    // observed on the status callback — only `'connected'` lands.
    expect(statuses).toContain('connected');

    // Subscribe payload carries both `bootstrap` (the credential) AND
    // `supportedVersions` (handshake opt-in).
    const sub = JSON.parse(MockWebSocket.instances[0]?.sent[0] ?? '{}') as {
      type: string;
      payload: {
        sessionId: string;
        appId: string;
        bootstrap: string;
        supportedVersions: string[];
      };
    };
    expect(sub.type).toBe('subscribe');
    expect(sub.payload.sessionId).toBe(BOOTSTRAP.sessionId);
    expect(sub.payload.appId).toBe(BOOTSTRAP.appId);
    expect(sub.payload.bootstrap).toBe(BOOTSTRAP.token);
    expect(sub.payload.supportedVersions).toEqual([...CLIENT_SUPPORTED_VERSIONS]);

    // Server emits ack — the promise resolves with the ack payload.
    MockWebSocket.instances[0]?.emit({
      type: 'ack',
      payload: {
        sequence: 1,
        timestamp: Date.now(),
        stack: [],
        serverVersion: PROTOCOL_SCHEMA_VERSION,
      },
    });

    const handle = await handlePromise;
    expect(handle.ack.sequence).toBe(1);
    expect(handle.ack.serverVersion).toBe(PROTOCOL_SCHEMA_VERSION);
    expect(handle.handle.kind).toBe('ws');
  });

  it('treats absent serverVersion as legacy-pass-through (no upgrade error)', async () => {
    const handlePromise = connectViaRegistry({
      bootstrap: BOOTSTRAP,
      registry: makeRegistry(),
      onStatusChange: () => {},
    });

    await vi.advanceTimersByTimeAsync(1);

    MockWebSocket.instances[0]?.emit({
      type: 'ack',
      payload: { sequence: 1, timestamp: Date.now() },
    });

    const handle = await handlePromise;
    expect(handle.ack.serverVersion).toBeUndefined();
  });
});

describe('connectViaRegistry — version handshake', () => {
  let originalWs: typeof WebSocket;

  beforeEach(() => {
    originalWs = global.WebSocket;
    MockWebSocket.instances = [];
    installMockWebSocket();
    vi.useFakeTimers();
  });

  afterEach(() => {
    global.WebSocket = originalWs;
    vi.useRealTimers();
  });

  it('rejects with UpgradeRequiredError when ack.serverVersion is unknown to the client', async () => {
    const handlePromise = connectViaRegistry({
      bootstrap: BOOTSTRAP,
      registry: makeRegistry(),
      onStatusChange: () => {},
    });

    await vi.advanceTimersByTimeAsync(1);

    MockWebSocket.instances[0]?.emit({
      type: 'ack',
      payload: {
        sequence: 1,
        timestamp: Date.now(),
        serverVersion: 'definitely-not-in-client-supported-versions',
      },
    });

    await expect(handlePromise).rejects.toBeInstanceOf(UpgradeRequiredError);
    try {
      await handlePromise;
    } catch (err) {
      expect(err).toBeInstanceOf(UpgradeRequiredError);
      if (err instanceof UpgradeRequiredError) {
        expect(err.code).toBe(UPGRADE_REQUIRED);
        expect(err.observedBy).toBe('client');
        expect(err.observedVersion).toBe('definitely-not-in-client-supported-versions');
        expect(err.acceptedVersions).toEqual(CLIENT_SUPPORTED_VERSIONS);
      }
    }
  });

  it('rejects with UpgradeRequiredError when server emits {type:"error", code:"UPGRADE_REQUIRED"} pre-ack', async () => {
    const handlePromise = connectViaRegistry({
      bootstrap: BOOTSTRAP,
      registry: makeRegistry(),
      onStatusChange: () => {},
    });

    await vi.advanceTimersByTimeAsync(1);

    MockWebSocket.instances[0]?.emit({
      type: 'error',
      payload: {
        code: UPGRADE_REQUIRED,
        message: 'unsupported',
        details: { serverVersion: 'v9001' },
      },
    });

    await expect(handlePromise).rejects.toBeInstanceOf(UpgradeRequiredError);
    try {
      await handlePromise;
    } catch (err) {
      if (err instanceof UpgradeRequiredError) {
        expect(err.observedBy).toBe('server');
        expect(err.observedVersion).toBe('v9001');
      }
    }
  });

  it('rejects with a plain Error when server emits a non-upgrade error pre-ack + emits typed ProtocolError', async () => {
    const emitted: ProtocolError[] = [];
    const handlePromise = connectViaRegistry({
      bootstrap: BOOTSTRAP,
      registry: makeRegistry(),
      onStatusChange: () => {},
      onProtocolError: (e) => emitted.push(e),
    });

    await vi.advanceTimersByTimeAsync(1);

    MockWebSocket.instances[0]?.emit({
      type: 'error',
      payload: { code: 'AUTH_REJECTED', message: 'token expired' },
    });

    await expect(handlePromise).rejects.toThrow('token expired');
    try {
      await handlePromise;
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(UpgradeRequiredError);
    }
    const authErr = emitted.find((e) => e.kind === 'auth');
    expect(authErr).toBeDefined();
    if (authErr && authErr.kind === 'auth') {
      expect(authErr.code).toBe('AUTH_REJECTED');
    }
  });

  it('forwards post-resolution frames through registered handlers (not via a callback)', async () => {
    const registry = makeRegistry();
    // Register a `progress` handler BEFORE bind so the registry routes
    // post-ack frames to it. Note: `ack` + `error` handlers are added
    // by `connectViaRegistry` itself; we register one for an unrelated
    // frame type that arrives post-resolution.
    const progressFrames: unknown[] = [];
    registry.register({
      type: 'progress',
      onMessage: (payload) => {
        progressFrames.push(payload);
      },
    });

    const handlePromise = connectViaRegistry({
      bootstrap: BOOTSTRAP,
      registry,
      onStatusChange: () => {},
    });

    await vi.advanceTimersByTimeAsync(1);

    MockWebSocket.instances[0]?.emit({
      type: 'ack',
      payload: { sequence: 1, timestamp: Date.now() },
    });
    await handlePromise;

    // Post-resolution `progress` frame routes to the handler.
    MockWebSocket.instances[0]?.emit({
      type: 'progress',
      payload: {
        sessionId: 'sess_001',
        stackItemId: 'p1',
        step: 'compiling',
        message: 'still working',
      },
    });

    expect(progressFrames).toHaveLength(1);
    expect((progressFrames[0] as { step?: string }).step).toBe('compiling');
  });
});
