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

/** A `connectFn` that records the meta the ladder was bound with. */
function recordingConnect(): { connectFn: ConnectFn; boundWith: McpAppAiGguiRenderMeta[] } {
  const boundWith: McpAppAiGguiRenderMeta[] = [];
  const connectFn: ConnectFn = async (opts) => {
    boundWith.push(opts.meta);
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
  return { connectFn, boundWith };
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
  const { connectFn, boundWith } = recordingConnect();
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
  return { result, transport, boundWith, notifyParent };
}

describe('boot with an expired live credential, live-only (ggui#1496 R1, F6)', () => {
  it('refreshes it through the host and binds the ladder with the adopted credential', async () => {
    const { result, transport, boundWith, notifyParent } = await boot(LIVE_ONLY_EXPIRED, (t) => {
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
      sseUrl: 'https://server.example/api/sessions/render_001/stream?wsToken=tok-new',
      pollingUrl: 'https://server.example/api/sessions/render_001/events?wsToken=tok-new',
    });
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
    const done = bootSequence({
      doc: document.implementation.createHTMLDocument('held-credential-ws'),
      app,
      transport,
      notifyParent: vi.fn(),
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
    // End the handshake with a terminal refusal so the boot settles.
    FakeWebSocket.instances[0]?.onmessage?.({
      data: JSON.stringify({ type: 'error', payload: { code: 'BOOTSTRAP_INVALID', message: 'test end' } }),
    });
    await done;
  });
});
