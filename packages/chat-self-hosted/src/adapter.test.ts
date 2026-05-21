/**
 * Adapter tests — contract-shaped.
 *
 * The self-hosted adapter is a thin fetch shim; the interesting
 * behaviors are wire-contract alignment (correct URL + method + body
 * per operation), error-envelope mapping, and SSE frame projection.
 * We inject a fake `fetch` that mimics the shipped server's response
 * envelopes so the tests pin the contract without booting a real
 * mcp-server process.
 */
import { describe, expect, it, vi } from 'vitest';
import { createSelfHostedGguiAdapter } from './adapter.js';
import { ThreadTransportError } from './errors.js';
import {
  createSelfHostedThread,
  getSelfHostedThread,
  listSelfHostedThreads,
} from './thread-ops.js';

const BASE_URL = 'http://localhost:4567';
const TOKEN = 'tok-abc';

function makeFetch(
  routes: Record<
    string,
    (req: { method: string; body: unknown }) => { status: number; body: unknown }
  >,
): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const pathOnly = url.replace(BASE_URL, '');
    const handler = routes[`${init?.method ?? 'GET'} ${pathOnly}`];
    if (!handler) {
      return new Response(
        JSON.stringify({ error: { code: 'not_found', message: 'no route' } }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
    const body =
      typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const { status, body: respBody } = handler({
      method: init?.method ?? 'GET',
      body,
    });
    return new Response(JSON.stringify(respBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('createSelfHostedGguiAdapter', () => {
  it('loadMessages GETs /threads/:id/messages and projects the payload', async () => {
    const fetchFn = makeFetch({
      'GET /threads/thr_1/messages': () => ({
        status: 200,
        body: {
          messages: [
            {
              threadId: 'thr_1',
              key: 'k1',
              seq: 1,
              at: '2026-04-20T00:00:00Z',
              authorRole: 'user',
              kind: 'text',
              blocks: [{ type: 'text', text: 'hi' }],
              textPreview: 'hi',
            },
          ],
        },
      }),
    });
    const adapter = createSelfHostedGguiAdapter({
      baseUrl: BASE_URL,
      pairingToken: TOKEN,
      fetch: fetchFn,
    });
    const messages = await adapter.loadMessages('thr_1');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      key: 'k1',
      seq: 1,
      textPreview: 'hi',
      cardSnapshot: null,
    });
  });

  it('appendMessage POSTs the right body and returns the stored message', async () => {
    const received: { body: unknown }[] = [];
    const fetchFn = makeFetch({
      'POST /threads/thr_1/messages': ({ body }) => {
        received.push({ body });
        return {
          status: 201,
          body: {
            threadId: 'thr_1',
            key: 'k2',
            seq: 2,
            at: '2026-04-20T00:00:01Z',
            authorRole: 'user',
            kind: 'text',
            blocks: [{ type: 'text', text: 'hello' }],
            textPreview: 'hello',
          },
        };
      },
    });
    const adapter = createSelfHostedGguiAdapter({
      baseUrl: BASE_URL,
      pairingToken: TOKEN,
      fetch: fetchFn,
    });
    const appended = await adapter.appendMessage({
      threadId: 'thr_1',
      key: 'k2',
      authorRole: 'user',
      kind: 'text',
      blocks: [{ type: 'text', text: 'hello' }],
      textPreview: 'hello',
    });
    expect(appended.seq).toBe(2);
    expect(received[0]!.body).toMatchObject({
      key: 'k2',
      authorRole: 'user',
      textPreview: 'hello',
    });
  });

  it('updateThreadState PATCHes /threads/:id with the action body', async () => {
    const received: { method: string; body: unknown }[] = [];
    const fetchFn = makeFetch({
      'PATCH /threads/thr_1': ({ method, body }) => {
        received.push({ method, body });
        return {
          status: 200,
          body: { id: 'thr_1', pinned: true, status: 'active' },
        };
      },
    });
    const adapter = createSelfHostedGguiAdapter({
      baseUrl: BASE_URL,
      pairingToken: TOKEN,
      fetch: fetchFn,
    });
    await adapter.updateThreadState('thr_1', 'pin');
    expect(received[0]).toEqual({ method: 'PATCH', body: { action: 'pin' } });
  });

  it('maps server 404 envelope to ThreadTransportError with isNotFound', async () => {
    const fetchFn = makeFetch({
      'GET /threads/missing/messages': () => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'thread not found: missing' } },
      }),
    });
    const adapter = createSelfHostedGguiAdapter({
      baseUrl: BASE_URL,
      pairingToken: TOKEN,
      fetch: fetchFn,
    });
    await expect(adapter.loadMessages('missing')).rejects.toBeInstanceOf(
      ThreadTransportError,
    );
    try {
      await adapter.loadMessages('missing');
    } catch (err) {
      const e = err as ThreadTransportError;
      expect(e.isNotFound).toBe(true);
      expect(e.code).toBe('not_found');
      expect(e.status).toBe(404);
    }
  });

  it('observeMessages accumulates SSE frames into cumulative snapshots', async () => {
    // Fake fetch returns a ReadableStream that emits three SSE frames,
    // then closes. The adapter should call onNext 3x with [1], [1,2],
    // [1,2,3] — same cumulative-snapshot shape as the cloud adapter's
    // observeQuery.
    const encoder = new TextEncoder();
    const frames = [1, 2, 3].map((seq) =>
      encoder.encode(
        `id: ${seq}\nevent: thread-message\ndata: ${JSON.stringify({
          type: 'thread-message',
          message: {
            threadId: 'thr_1',
            key: `k${seq}`,
            seq,
            at: `2026-04-20T00:00:0${seq}Z`,
            authorRole: 'agent',
            kind: 'text',
            blocks: [],
            textPreview: `m${seq}`,
          },
        })}\n\n`,
      ),
    );

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        frames.forEach((f) => controller.enqueue(f));
        controller.close();
      },
    });

    const fetchFn = vi.fn(
      async () =>
        new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    ) as unknown as typeof fetch;

    const adapter = createSelfHostedGguiAdapter({
      baseUrl: BASE_URL,
      pairingToken: TOKEN,
      fetch: fetchFn,
    });

    const snapshots: Array<{ seq: number; textPreview: string }[]> = [];
    const errors: Error[] = [];
    const close = adapter.observeMessages(
      'thr_1',
      (messages) => {
        snapshots.push(messages.map((m) => ({ seq: m.seq, textPreview: m.textPreview })));
      },
      (err) => {
        errors.push(err);
      },
    );

    // Give the fetch + reader time to drain all frames.
    await waitFor(
      () => snapshots.length === 3 || errors.length > 0,
      500,
    );
    expect(errors).toEqual([]);
    expect(snapshots[0]).toEqual([{ seq: 1, textPreview: 'm1' }]);
    expect(snapshots[1]).toEqual([
      { seq: 1, textPreview: 'm1' },
      { seq: 2, textPreview: 'm2' },
    ]);
    expect(snapshots[2]).toEqual([
      { seq: 1, textPreview: 'm1' },
      { seq: 2, textPreview: 'm2' },
      { seq: 3, textPreview: 'm3' },
    ]);
    close();
  });
});

describe('thread-ops', () => {
  it('createSelfHostedThread posts the expected body to /threads', async () => {
    const received: { body: unknown }[] = [];
    const fetchFn = makeFetch({
      'POST /threads': ({ body }) => {
        received.push({ body });
        return {
          status: 201,
          body: {
            id: 'thr_42',
            appId: 'app-1',
            ownerId: 'paired_alice',
            lastSeq: 0,
            unreadCount: 0,
            pinned: false,
            muted: false,
            status: 'active',
            createdAt: '2026-04-20T00:00:00Z',
            updatedAt: '2026-04-20T00:00:00Z',
            title: 'hello',
          },
        };
      },
    });
    const thread = await createSelfHostedThread(
      { baseUrl: BASE_URL, pairingToken: TOKEN, fetch: fetchFn },
      { appId: 'app-1', firstMessageHint: 'hello' },
    );
    expect(thread.id).toBe('thr_42');
    expect(received[0]!.body).toEqual({
      appId: 'app-1',
      firstMessageHint: 'hello',
    });
  });

  it('listSelfHostedThreads serializes filter to query params', async () => {
    const seenUrls: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      seenUrls.push(url);
      return new Response(
        JSON.stringify({ threads: [], nextCursor: undefined }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as typeof fetch;
    await listSelfHostedThreads(
      { baseUrl: BASE_URL, pairingToken: TOKEN, fetch: fetchFn },
      { status: 'active', limit: 25 },
    );
    expect(seenUrls[0]).toContain('?');
    expect(seenUrls[0]).toContain('status=active');
    expect(seenUrls[0]).toContain('limit=25');
  });

  it('getSelfHostedThread surfaces 404 as ThreadTransportError.isNotFound', async () => {
    const fetchFn = makeFetch({
      'GET /threads/ghost': () => ({
        status: 404,
        body: { error: { code: 'not_found', message: 'thread not found: ghost' } },
      }),
    });
    await expect(
      getSelfHostedThread(
        { baseUrl: BASE_URL, pairingToken: TOKEN, fetch: fetchFn },
        'ghost',
      ),
    ).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});

async function waitFor(
  pred: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  while (!pred() && Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 5));
  }
  if (!pred()) throw new Error('waitFor: timeout');
}
