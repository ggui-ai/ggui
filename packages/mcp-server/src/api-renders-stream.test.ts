/**
 * Tests for `GET /api/sessions/:sessionId/stream?wsToken=…` — the
 * wsToken-gated SSE live stream (the ladder's middle rung).
 *
 * # What this proves
 *
 *   - Auth gates run as plain HTTP BEFORE any event-stream byte:
 *     401 missing/invalid/wrong-scope wsToken, 410 expired, 404
 *     unknown render, 503 channel-not-ready (pre-listen only).
 *   - Framing: `retry: 3000` first, then the ack ChannelFrame (id-less),
 *     then GguiSessionEvent-ledger `render_event` replay frames, each
 *     preceded by `id: <ledger seq>` — the browser's `Last-Event-ID`
 *     lands on the /events `sinceSequence` cursor space.
 *   - `Last-Event-ID` header WINS over the `?sinceSequence=` query.
 *   - Live fan-out: `sendPropsUpdate` reaches the SSE subscriber
 *     through the same sink walk as WS, id-less.
 *   - Heartbeat `: hb` comments flow at the configured cadence.
 *   - Teardown: client disconnect detaches the subscriber from the
 *     channel (subscriberCount returns to 0).
 *
 * Lane 3 of the 4-lane taxonomy (in-process, loopback HTTP).
 */
import express from 'express';
import type { Server as HttpServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { mintWsToken } from '@ggui-ai/mcp-server-core';
import {
  InMemoryAuthAdapter,
  InMemoryCodeStore,
  InMemoryGguiSessionStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import { mountApiRendersStreamRoute } from './api-renders-stream-route.js';
import {
  createGguiSessionChannelServer,
  type GguiSessionChannelServer,
} from './ggui-session-channel.js';
import { createGguiServer, type GguiServer } from './server.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

const SECRET = 'deterministic-test-secret-' + 'x'.repeat(32);

// ── SSE stream reader ────────────────────────────────────────────────
//
// Background-pumps the fetch body into a growing text buffer; tests
// poll the buffer with a predicate. No Promise.race against
// reader.read() — a lost race there leaves a dangling read that
// rejects on abort as an unhandled rejection.

interface SseStream {
  readUntil(pred: (buf: string) => boolean, timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
}

async function openStream(
  url: string,
  headers: Record<string, string> = {},
): Promise<SseStream> {
  const controller = new AbortController();
  const res = await fetch(url, { headers, signal: controller.signal });
  if (res.status !== 200) {
    controller.abort();
    throw new Error(`expected 200 event-stream, got ${res.status}`);
  }
  if (res.headers.get('access-control-allow-origin') !== '*') {
    controller.abort();
    throw new Error('stream 200 missing Access-Control-Allow-Origin');
  }
  if (!res.body) throw new Error('response has no body stream');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const pump = (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += decoder.decode(value, { stream: true });
      }
    } catch {
      // Aborted by close() — expected teardown path.
    }
  })();
  return {
    async readUntil(pred, timeoutMs = 5_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (pred(buf)) return buf;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`SSE readUntil timed out; buffer so far:\n${buf}`);
    },
    async close() {
      controller.abort();
      await pump;
    },
  };
}

/**
 * Split an SSE buffer into dispatched event blocks (separated by the
 * blank line), dropping the `retry:` preamble and `: hb` comments.
 * Each block parses to `{ id?, frame }`.
 */
function parseEventBlocks(buf: string): Array<{ id?: string; frame: { type: string } }> {
  const blocks: Array<{ id?: string; frame: { type: string } }> = [];
  for (const rawBlock of buf.split('\n\n')) {
    const lines = rawBlock.split('\n').filter((l) => l.length > 0);
    const dataLine = lines.find((l) => l.startsWith('data: '));
    if (!dataLine) continue; // retry preamble / heartbeat comment
    const idLine = lines.find((l) => l.startsWith('id: '));
    blocks.push({
      ...(idLine !== undefined ? { id: idLine.slice('id: '.length) } : {}),
      frame: JSON.parse(dataLine.slice('data: '.length)) as { type: string },
    });
  }
  return blocks;
}

// ── Fixture A: full server (proves the server.ts mount) ─────────────

interface ServerFixture {
  server: GguiServer;
  url: string;
  sessionId: string;
  appId: string;
  validToken: string;
  store: InMemoryGguiSessionStore;
}

async function bootServer(opts: { eventCount?: number } = {}): Promise<ServerFixture> {
  const renderStore = new InMemoryGguiSessionStore();
  const stored = await renderStore.create({ appId: 'app-stream-test' });
  const seedCount = opts.eventCount ?? 0;
  for (let i = 0; i < seedCount; i += 1) {
    await renderStore.appendEvent({
      sessionId: stored.id,
      type: 'ui.created',
      data: { i, label: `event-${i}` },
    });
  }
  const server = createGguiServer({
    logger: silentLogger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    mcpApps: true,
    renderChannel: true,
    renderStore,
    shortCodeIndex: new InMemoryShortCodeIndex(),
    wsTokenSecret: SECRET,
    codeStore: new InMemoryCodeStore(),
    publicBaseUrl: 'https://test.example',
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  const { token } = mintWsToken({ sessionId: stored.id, appId: stored.appId }, SECRET);
  return {
    server,
    url: `http://127.0.0.1:${addr.port}`,
    sessionId: stored.id,
    appId: stored.appId,
    validToken: token,
    store: renderStore,
  };
}

// ── Fixture B: direct mount (channel handle + heartbeat override) ───

interface DirectFixture {
  httpServer: HttpServer;
  url: string;
  sessionId: string;
  appId: string;
  validToken: string;
  channel: GguiSessionChannelServer;
}

async function bootDirect(opts: { heartbeatMs?: number } = {}): Promise<DirectFixture> {
  const renderStore = new InMemoryGguiSessionStore();
  const stored = await renderStore.create({ appId: 'app-direct-test' });
  const channel = createGguiSessionChannelServer({
    renderStore,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    logger: silentLogger,
  });
  const app = express();
  mountApiRendersStreamRoute({
    app,
    renderStore,
    secret: SECRET,
    channelProvider: () => channel,
    ...(opts.heartbeatMs !== undefined ? { heartbeatMs: opts.heartbeatMs } : {}),
    logger: silentLogger,
  });
  const httpServer = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => httpServer.once('listening', resolve));
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('app.listen() did not return AddressInfo');
  }
  const { token } = mintWsToken({ sessionId: stored.id, appId: stored.appId }, SECRET);
  return {
    httpServer,
    url: `http://127.0.0.1:${addr.port}`,
    sessionId: stored.id,
    appId: stored.appId,
    validToken: token,
    channel,
  };
}

function streamUrl(fx: { url: string; sessionId: string }, query: string): string {
  return `${fx.url}/api/sessions/${fx.sessionId}/stream?${query}`;
}

describe('GET /api/sessions/:sessionId/stream — auth gates (plain HTTP, pre-stream)', () => {
  let fx: ServerFixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('401 when wsToken query is missing', async () => {
    fx = await bootServer();
    const res = await fetch(`${fx.url}/api/sessions/${fx.sessionId}/stream`);
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('wsToken query required');
  });

  it('401 when wsToken is invalid', async () => {
    fx = await bootServer();
    const res = await fetch(streamUrl(fx, 'wsToken=garbage'));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('wsToken invalid');
  });

  it('410 when wsToken is expired', async () => {
    fx = await bootServer();
    const { token } = mintWsToken(
      { sessionId: fx.sessionId, appId: fx.appId, ttlSec: -10 },
      SECRET,
    );
    const res = await fetch(streamUrl(fx, `wsToken=${encodeURIComponent(token)}`));
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('wsToken expired');
    // EventSource can only distinguish "refresh the token and retry"
    // from "structurally unreachable" if the 410 is CORS-readable.
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('401 when the wsToken is scoped to a different render', async () => {
    fx = await bootServer();
    const { token } = mintWsToken({ sessionId: 'some-other-render', appId: fx.appId }, SECRET);
    const res = await fetch(streamUrl(fx, `wsToken=${encodeURIComponent(token)}`));
    expect(res.status).toBe(401);
    expect(await res.text()).toContain('wsToken scope mismatch');
  });

  it('404 when the render does not exist', async () => {
    fx = await bootServer();
    const ghost = 'ghost-render-id';
    const { token } = mintWsToken({ sessionId: ghost, appId: fx.appId }, SECRET);
    const res = await fetch(
      `${fx.url}/api/sessions/${ghost}/stream?wsToken=${encodeURIComponent(token)}`,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('render not found');
  });

  it('400 when sinceSequence is malformed', async () => {
    fx = await bootServer();
    const res = await fetch(
      streamUrl(fx, `wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=nope`),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /api/sessions/:sessionId/stream — 503 channel-not-ready', () => {
  it('answers 503 when the channelProvider resolves null (pre-listen only)', async () => {
    const renderStore = new InMemoryGguiSessionStore();
    const stored = await renderStore.create({ appId: 'app-503-test' });
    const app = express();
    mountApiRendersStreamRoute({
      app,
      renderStore,
      secret: SECRET,
      channelProvider: () => null,
      logger: silentLogger,
    });
    const httpServer = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => httpServer.once('listening', resolve));
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('no AddressInfo');
    try {
      const { token } = mintWsToken({ sessionId: stored.id, appId: stored.appId }, SECRET);
      const res = await fetch(
        `http://127.0.0.1:${addr.port}/api/sessions/${stored.id}/stream?wsToken=${encodeURIComponent(token)}`,
      );
      expect(res.status).toBe(503);
      expect(await res.text()).toContain('live channel not ready');
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
  });
});

describe('GET /api/sessions/:sessionId/stream — framing + ledger replay', () => {
  let fx: ServerFixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('emits retry: 3000, then an id-less ack, then render_event replay frames each carrying id: <ledger seq>', async () => {
    fx = await bootServer({ eventCount: 3 });
    const stream = await openStream(
      streamUrl(fx, `wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=0`),
    );
    try {
      const buf = await stream.readUntil(
        (b) => (b.match(/"type":"render_event"/g) ?? []).length >= 3,
      );
      // Reconnect hint precedes everything else on the wire.
      expect(buf.startsWith('retry: 3000\n\n')).toBe(true);
      const blocks = parseEventBlocks(buf);
      // Ack first (ChannelFrame shape, id-less — ephemeral posture).
      expect(blocks[0]?.frame.type).toBe('ack');
      expect(blocks[0]?.id).toBeUndefined();
      // Then the ledger replay: ids are the decimal GguiSessionEvent
      // seqs — the same cursor space /events?sinceSequence=N reads.
      const events = blocks.filter((b) => b.frame.type === 'render_event');
      expect(events.map((b) => b.id)).toEqual(['1', '2', '3']);
      const ackIndex = blocks.findIndex((b) => b.frame.type === 'ack');
      const firstEventIndex = blocks.findIndex((b) => b.frame.type === 'render_event');
      expect(ackIndex).toBeLessThan(firstEventIndex);
    } finally {
      await stream.close();
    }
  });

  it('Last-Event-ID header wins over the ?sinceSequence= query', async () => {
    fx = await bootServer({ eventCount: 3 });
    const stream = await openStream(
      streamUrl(fx, `wsToken=${encodeURIComponent(fx.validToken)}&sinceSequence=0`),
      { 'Last-Event-ID': '2' },
    );
    try {
      const buf = await stream.readUntil((b) => b.includes('"type":"render_event"'));
      const events = parseEventBlocks(buf).filter((b) => b.frame.type === 'render_event');
      // Cursor 2 → only ledger seq 3 replays; seqs 1-2 stay behind it.
      expect(events.map((b) => b.id)).toEqual(['3']);
    } finally {
      await stream.close();
    }
  });
});

describe('GET /api/sessions/:sessionId/stream — live fan-out, heartbeat, teardown', () => {
  let fx: DirectFixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.channel.close();
      await new Promise<void>((resolve) => fx?.httpServer.close(() => resolve()));
      fx = null;
    }
  });

  it('a props_update fanned out by the channel reaches the SSE subscriber, id-less', async () => {
    fx = await bootDirect();
    const stream = await openStream(
      streamUrl(fx, `wsToken=${encodeURIComponent(fx.validToken)}`),
    );
    try {
      await stream.readUntil((b) => b.includes('"type":"ack"'));
      await fx.channel.sendPropsUpdate(fx.sessionId, { headline: 'fresh' });
      const buf = await stream.readUntil((b) => b.includes('"type":"props_update"'));
      const block = parseEventBlocks(buf).find((b) => b.frame.type === 'props_update');
      expect(block).toBeDefined();
      // Live frames are id-less — only ledger-backed replay frames
      // advance Last-Event-ID.
      expect(block?.id).toBeUndefined();
      expect(block?.frame).toMatchObject({
        type: 'props_update',
        payload: { sessionId: fx.sessionId, props: { headline: 'fresh' } },
      });
    } finally {
      await stream.close();
    }
  });

  it('writes `: hb` heartbeat comments at the configured cadence', async () => {
    fx = await bootDirect({ heartbeatMs: 30 });
    const stream = await openStream(
      streamUrl(fx, `wsToken=${encodeURIComponent(fx.validToken)}`),
    );
    try {
      const buf = await stream.readUntil((b) => (b.match(/: hb\n\n/g) ?? []).length >= 2);
      expect(buf).toContain(': hb');
    } finally {
      await stream.close();
    }
  });

  it('client disconnect detaches the subscriber from the channel', async () => {
    fx = await bootDirect();
    const stream = await openStream(
      streamUrl(fx, `wsToken=${encodeURIComponent(fx.validToken)}`),
    );
    await stream.readUntil((b) => b.includes('"type":"ack"'));
    expect(fx.channel.subscriberCount).toBe(1);
    await stream.close();
    // res 'close' fires on the server shortly after the abort; the
    // teardown path must unregister (pump ends, StreamFanout unhooks).
    const deadline = Date.now() + 5_000;
    while (fx.channel.subscriberCount !== 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fx.channel.subscriberCount).toBe(0);
  });
});
