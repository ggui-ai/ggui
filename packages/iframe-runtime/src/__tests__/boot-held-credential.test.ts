/**
 * ggui#1496 part B (runtime) — a view that boots holding an expired live
 * credential refreshes it once through its host before any ladder binds
 * (R1), on either slice shape.
 *
 * - Live-only: the refresh is the view's only way to a live channel. An
 *   adopted credential boots the ladder with it; a definitive refusal ends
 *   the boot as `EXPIRED_BOOTSTRAP` at once; a relay error is re-sent twice
 *   before it does (F6).
 * - With static content: the refresh is sent once, with no retry; whatever
 *   it answers, the boot goes on.
 * - A credential that has not expired is never refreshed at boot.
 */
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { bootSequence, type RendererBootFailedMessage } from '../runtime.js';
import type { ConnectFn } from '../registry-subscribe.js';
import { buildBootHarness, tick } from './boot-helpers.js';
import type { MockTransport } from './mock-transport.js';

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

const LIVE_ONLY_EXPIRED: McpAppAiGguiRenderMeta = {
  sessionId: 'render_001',
  appId: 'app_001',
  runtimeUrl: '/_ggui/iframe-runtime.js',
  wsUrl: 'wss://server.example/ws',
  wsToken: 'tok-old',
  sseUrl: 'https://server.example/api/sessions/render_001/stream?wsToken=tok-old',
  pollingUrl: 'https://server.example/api/sessions/render_001/events?wsToken=tok-old',
  expiresAt: PAST,
};

const noWait = { sleep: async (): Promise<void> => undefined, random: (): number => 0 };

/** A `connectFn` that records the meta and the options each ladder was bound with. */
function recordingConnect(): {
  connectFn: ConnectFn;
  boundWith: McpAppAiGguiRenderMeta[];
  bindOptions: Parameters<ConnectFn>[0][];
} {
  const boundWith: McpAppAiGguiRenderMeta[] = [];
  const bindOptions: Parameters<ConnectFn>[0][] = [];
  const connectFn: ConnectFn = async (opts) => {
    boundWith.push(opts.meta);
    bindOptions.push(opts);
    return {
      handle: {
        kind: 'ws' as const,
        status: 'open' as const,
        send: vi.fn(),
        start: vi.fn(),
        dispose: async () => {},
      },
      ack: { sequence: 1, timestamp: Date.now(), serverVersion: undefined },
    };
  };
  return { connectFn, boundWith, bindOptions };
}

/** The `tools/call` requests the view sent for the refresh, as `arguments`. */
function refreshCalls(transport: MockTransport): unknown[] {
  return transport.sent.flatMap((m) => {
    const msg = m as { method?: unknown; params?: { name?: unknown; arguments?: unknown } };
    return msg.method === 'tools/call' && msg.params?.name === 'ggui_runtime_refresh_ws_token'
      ? [msg.params.arguments]
      : [];
  });
}

function adoptedReply(envelope: string, expiresAt: string) {
  return {
    result: {
      structuredContent: { ok: true, envelope, expiresAt },
      content: [{ type: 'text', text: JSON.stringify({ ok: true, envelope, expiresAt }) }],
    },
  };
}

function bootFailures(notifyParent: ReturnType<typeof vi.fn>): RendererBootFailedMessage[] {
  return notifyParent.mock.calls
    .map((c: unknown[]) => c[0])
    .filter(
      (m: unknown): m is RendererBootFailedMessage =>
        m !== null && typeof m === 'object' && (m as { type?: unknown }).type === 'ggui:bootstrap-failed',
    );
}

async function boot(
  meta: McpAppAiGguiRenderMeta,
  queue: (transport: MockTransport) => void,
) {
  const { app, transport, pushToolResult } = buildBootHarness();
  queue(transport);
  const { connectFn, boundWith, bindOptions } = recordingConnect();
  const notifyParent = vi.fn();
  const done = bootSequence({
    doc: document.implementation.createHTMLDocument('held-credential'),
    app,
    transport,
    connectFn,
    notifyParent,
    toolResultTimeoutMs: 500,
    credentialTiming: noWait,
  });
  await tick();
  pushToolResult(meta);
  const result = await done;
  return { result, transport, boundWith, bindOptions, notifyParent };
}

describe('boot with an expired live credential, live-only (ggui#1496 R1, F6)', () => {
  it('refreshes it through the host and binds the ladder with the adopted credential', async () => {
    const { result, transport, boundWith, bindOptions, notifyParent } = await boot(LIVE_ONLY_EXPIRED, (t) => {
      t.queueResponse('tools/call', adoptedReply('tok-new', FUTURE));
    });
    expect(refreshCalls(transport)).toEqual([{ envelope: 'tok-old' }]);
    expect(result.ok).toBe(true);
    expect(bootFailures(notifyParent)).toHaveLength(0);
    expect(boundWith).toHaveLength(1);
    expect(boundWith[0]).toMatchObject({
      sessionId: 'render_001',
      wsUrl: 'wss://server.example/ws',
      wsToken: 'tok-new',
      expiresAt: FUTURE,
    });
    // The fallback rungs carry the re-derived URLs of the adopted credential.
    expect(bindOptions[0]?.sse?.url).toBe('https://server.example/api/sessions/render_001/stream?wsToken=tok-new');
    expect(bindOptions[0]?.polling?.url).toContain('https://server.example/api/sessions/render_001/events?wsToken=tok-new');
  });

  it('ends the boot as EXPIRED_BOOTSTRAP at once on a definitive refusal, binding nothing', async () => {
    const { result, transport, boundWith, notifyParent } = await boot(LIVE_ONLY_EXPIRED, (t) => {
      t.queueResponse('tools/call', {
        result: {
          structuredContent: { ok: false, code: 'BOOTSTRAP_INVALID', message: 'bad signature' },
          content: [{ type: 'text', text: '{"ok":false,"code":"BOOTSTRAP_INVALID"}' }],
        },
      });
    });
    expect(refreshCalls(transport)).toHaveLength(1);
    expect(result.ok).toBe(false);
    expect(boundWith).toHaveLength(0);
    expect(bootFailures(notifyParent).map((f) => f.reason)).toEqual(['EXPIRED_BOOTSTRAP']);
  });

  it('re-sends the refresh twice after a relay error, then ends the boot as EXPIRED_BOOTSTRAP', async () => {
    const { result, transport, boundWith, notifyParent } = await boot(LIVE_ONLY_EXPIRED, (t) => {
      for (let i = 0; i < 3; i++) t.queueResponse('tools/call', { error: { code: -32603, message: 'relay down' } });
    });
    expect(refreshCalls(transport)).toHaveLength(3);
    expect(result.ok).toBe(false);
    expect(boundWith).toHaveLength(0);
    expect(bootFailures(notifyParent).map((f) => f.reason)).toEqual(['EXPIRED_BOOTSTRAP']);
  });

  it('adopts on a retry that succeeds', async () => {
    const { result, transport, boundWith } = await boot(LIVE_ONLY_EXPIRED, (t) => {
      t.queueResponse('tools/call', { error: { code: -32603, message: 'relay down' } });
      t.queueResponse('tools/call', adoptedReply('tok-new', FUTURE));
    });
    expect(refreshCalls(transport)).toHaveLength(2);
    expect(result.ok).toBe(true);
    expect(boundWith[0]?.wsToken).toBe('tok-new');
  });
});

describe('boot with an expired live credential and static content (ggui#1496 R1)', () => {
  const STATIC_EXPIRED: McpAppAiGguiRenderMeta = {
    ...LIVE_ONLY_EXPIRED,
    codeUrl: 'https://server.example/code/c.js',
  };

  it('refreshes it once and binds the ladder with the adopted credential', async () => {
    const { transport, boundWith } = await boot(STATIC_EXPIRED, (t) => {
      t.queueResponse('tools/call', adoptedReply('tok-new', FUTURE));
    });
    expect(refreshCalls(transport)).toEqual([{ envelope: 'tok-old' }]);
    expect(boundWith[0]).toMatchObject({ wsToken: 'tok-new', wsUrl: 'wss://server.example/ws' });
  });

  it('sends the refresh once, with no retry, when the relay errors', async () => {
    const { transport } = await boot(STATIC_EXPIRED, (t) => {
      for (let i = 0; i < 3; i++) t.queueResponse('tools/call', { error: { code: -32603, message: 'relay down' } });
    });
    expect(refreshCalls(transport)).toHaveLength(1);
  });
});

describe('boot with a live credential that has not expired (ggui#1496 R1)', () => {
  it('sends no refresh and binds with the credential it was given', async () => {
    const { result, transport, boundWith } = await boot({ ...LIVE_ONLY_EXPIRED, expiresAt: FUTURE }, () => {});
    expect(refreshCalls(transport)).toHaveLength(0);
    expect(result.ok).toBe(true);
    expect(boundWith[0]?.wsToken).toBe('tok-old');
  });
});

describe('the subscribe payload carries the adopted token (ggui#1496 F5)', () => {
  /** Just enough WebSocket for the WS rung: opens on the next tick and records what it is sent. */
  class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: FakeWebSocket[] = [];
    readyState = FakeWebSocket.CONNECTING;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    onerror: (() => void) | null = null;
    readonly sent: string[] = [];
    constructor(readonly url: string) {
      FakeWebSocket.instances.push(this);
      setTimeout(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      }, 0);
    }
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
      this.onclose?.();
    }
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as { WebSocket: unknown }).WebSocket = FakeWebSocket;
  });
  afterEach(() => {
    delete (globalThis as { WebSocket?: unknown }).WebSocket;
  });

  it('the first subscribe after a boot refresh sends the adopted wsToken, never the expired one', async () => {
    const { app, transport, pushToolResult } = buildBootHarness();
    transport.queueResponse('tools/call', adoptedReply('tok-new', FUTURE));
    const notifyParent = vi.fn();
    const done = bootSequence({
      doc: document.implementation.createHTMLDocument('held-credential-ws'),
      app,
      transport,
      notifyParent,
      toolResultTimeoutMs: 500,
      credentialTiming: noWait,
    });
    await tick();
    pushToolResult(LIVE_ONLY_EXPIRED);
    let first: string | undefined;
    for (let i = 0; i < 200 && first === undefined; i++) {
      await tick();
      first = FakeWebSocket.instances[0]?.sent[0];
    }
    if (first === undefined) throw new Error('no subscribe frame was sent');
    const frame: unknown = JSON.parse(first);
    expect(frame).toMatchObject({ type: 'subscribe', payload: { sessionId: 'render_001', wsToken: 'tok-new' } });
    // End the handshake with an auth refusal. It resolves with the ladder
    // (fact 3), and a boot with nothing painted still ends as it did when
    // the refusal rejected.
    FakeWebSocket.instances[0]?.onmessage?.({
      data: JSON.stringify({ type: 'error', payload: { code: 'BOOTSTRAP_INVALID', message: 'test end' } }),
    });
    const result = await done;
    expect(result.ok).toBe(false);
    expect(bootFailures(notifyParent).map((f) => f.reason)).toEqual(['WS_HANDSHAKE_FAILED']);
  });

  it('a BOOTSTRAP_EXPIRED after the ack refreshes through the host and rebinds on a new socket; the old one goes at the new ack (R1, R3)', async () => {
    const { app, transport, pushToolResult } = buildBootHarness();
    transport.respondBy('tools/call', (params) => {
      const name = typeof params === 'object' && params !== null ? Reflect.get(params, 'name') : undefined;
      if (name === 'ggui_runtime_refresh_ws_token') return adoptedReply('tok-new', FUTURE);
      const body = { events: [], lastSequence: 0, hasMore: false };
      return { result: { structuredContent: body, content: [{ type: 'text', text: JSON.stringify(body) }] } };
    });
    const done = bootSequence({
      doc: document.implementation.createHTMLDocument('held-credential-rebind'),
      app,
      transport,
      notifyParent: vi.fn(),
      toolResultTimeoutMs: 500,
      credentialTiming: noWait,
    });
    await tick();
    const { sseUrl: _sse, pollingUrl: _polling, ...wsOnly } = LIVE_ONLY_EXPIRED;
    pushToolResult({ ...wsOnly, expiresAt: FUTURE });
    const socket = async (index: number): Promise<FakeWebSocket> => {
      for (let i = 0; i < 200; i++) {
        const ws = FakeWebSocket.instances[index];
        if (ws !== undefined && ws.sent.length > 0) return ws;
        await tick();
      }
      throw new Error(`socket ${index} never subscribed`);
    };
    const ackFrame = JSON.stringify({ type: 'ack', payload: { sequence: 1, timestamp: 0 } });
    const boot = await socket(0);
    boot.onmessage?.({ data: ackFrame });
    expect((await done).ok).toBe(true);

    boot.onmessage?.({
      data: JSON.stringify({ type: 'error', payload: { code: 'BOOTSTRAP_EXPIRED', message: 'expired' } }),
    });
    const next = await socket(1);
    expect(next.url).toContain('wsToken=tok-new');
    const subscribe: unknown = JSON.parse(next.sent[0] ?? '{}');
    expect(subscribe).toMatchObject({ type: 'subscribe', payload: { wsToken: 'tok-new' } });

    next.onmessage?.({ data: ackFrame });
    await tick();
    expect(next.readyState).toBe(FakeWebSocket.OPEN);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  /** Boot live-only on WS with an unexpired credential the server then refuses before its ack. */
  async function refusedAtSubscribe(refresh: () => unknown) {
    const { app, transport, pushToolResult } = buildBootHarness();
    transport.respondBy('tools/call', (params) => {
      const name = typeof params === 'object' && params !== null ? Reflect.get(params, 'name') : undefined;
      if (name === 'ggui_runtime_refresh_ws_token') return { result: refresh() };
      const body = { events: [], lastSequence: 0, hasMore: false };
      return { result: { structuredContent: body, content: [{ type: 'text', text: JSON.stringify(body) }] } };
    });
    const notifyParent = vi.fn();
    const done = bootSequence({
      doc: document.implementation.createHTMLDocument('held-credential-refused'),
      app,
      transport,
      notifyParent,
      toolResultTimeoutMs: 500,
      credentialTiming: noWait,
    });
    await tick();
    const { sseUrl: _sse, pollingUrl: _polling, ...wsOnly } = LIVE_ONLY_EXPIRED;
    pushToolResult({ ...wsOnly, expiresAt: FUTURE });
    for (let i = 0; i < 200 && (FakeWebSocket.instances[0]?.sent.length ?? 0) === 0; i++) await tick();
    FakeWebSocket.instances[0]?.onmessage?.({
      data: JSON.stringify({ type: 'error', payload: { code: 'BOOTSTRAP_EXPIRED', message: 'expired' } }),
    });
    return { result: await done, notifyParent };
  }

  it('a BOOTSTRAP_EXPIRED refusal before the ack, refreshed: the boot goes on, and the new ladder subscribes with the adopted token', async () => {
    const { result, notifyParent } = await refusedAtSubscribe(
      () => adoptedReply('tok-new', FUTURE).result,
    );
    expect(result.ok).toBe(true);
    expect(bootFailures(notifyParent)).toHaveLength(0);
    let next: FakeWebSocket | undefined;
    for (let i = 0; i < 200 && (next === undefined || next.sent.length === 0); i++) {
      await tick();
      next = FakeWebSocket.instances[1];
    }
    if (next === undefined) throw new Error('no rebind socket');
    expect(next.url).toContain('wsToken=tok-new');
  });

  it('R4: a not-found on the bridge after a successful pull ends the live channel, with one typed error and one observability event', async () => {
    const { app, transport, pushToolResult } = buildBootHarness();
    let pulls = 0;
    transport.respondBy('tools/call', () => {
      pulls += 1;
      if (pulls >= 2) {
        return { result: { isError: true, content: [{ type: 'text', text: 'session_not_found: no live session render_001' }] } };
      }
      const body = { events: [], lastSequence: 0, hasMore: false };
      return { result: { structuredContent: body, content: [{ type: 'text', text: JSON.stringify(body) }] } };
    });
    const protocolErrors: unknown[] = [];
    const observed: unknown[] = [];
    const done = bootSequence({
      doc: document.implementation.createHTMLDocument('held-credential-r4'),
      app,
      transport,
      notifyParent: vi.fn(),
      toolResultTimeoutMs: 500,
      credentialTiming: noWait,
      onProtocolError: (e) => protocolErrors.push(e),
      onObserve: (e) => observed.push(e),
    });
    await tick();
    const { sseUrl: _sse, pollingUrl: _polling, ...wsOnly } = LIVE_ONLY_EXPIRED;
    pushToolResult({ ...wsOnly, expiresAt: FUTURE });
    for (let i = 0; i < 200 && (FakeWebSocket.instances[0]?.sent.length ?? 0) === 0; i++) await tick();
    const boot = FakeWebSocket.instances[0];
    boot?.onmessage?.({ data: JSON.stringify({ type: 'ack', payload: { sequence: 1, timestamp: 0 } }) });
    expect((await done).ok).toBe(true);
    // The server drops the session: WS refuses, the ladder demotes to its bridge.
    boot?.onmessage?.({
      data: JSON.stringify({ type: 'error', payload: { code: 'SESSION_NOT_FOUND', message: 'gone' } }),
    });
    const ended = (): boolean =>
      observed.some((e) => typeof e === 'object' && e !== null && Reflect.get(e, 'reason') === 'live-channel-ended');
    for (let i = 0; i < 400 && !ended(); i++) await tick();
    expect(observed).toContainEqual({
      kind: 'subscribe-failed',
      reason: 'live-channel-ended',
      message: 'the session is gone (session_not_found, after a successful pull)',
    });
    expect(protocolErrors).toContainEqual({
      kind: 'transport',
      code: 'DISCONNECTED',
      retryable: false,
      message: 'the session is gone (session_not_found, after a successful pull)',
    });
    const pullsAtEnd = pulls;
    for (let i = 0; i < 20; i++) await tick();
    expect(pulls).toBe(pullsAtEnd);
  });

  it('a BOOTSTRAP_EXPIRED refusal before the ack whose refresh is refused ends the boot as before (WS_HANDSHAKE_FAILED)', async () => {
    const { result, notifyParent } = await refusedAtSubscribe(() => ({
      structuredContent: { ok: false, code: 'BOOTSTRAP_NOT_SUPPORTED', message: 'no refresh here' },
      content: [{ type: 'text', text: '{"ok":false,"code":"BOOTSTRAP_NOT_SUPPORTED"}' }],
    }));
    expect(result.ok).toBe(false);
    expect(bootFailures(notifyParent).map((f) => f.reason)).toEqual(['WS_HANDSHAKE_FAILED']);
  });
});
