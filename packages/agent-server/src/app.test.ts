/**
 * Integration tests for `createAgentApp` — exercise the Hono app's
 * request path including auth gating, chat ownership enforcement,
 * SSE event ordering, and the principal stash. Uses Hono's
 * `app.request()` for end-to-end fetch without binding a real port.
 *
 * Skips the SSE-body assertions in vitest's node environment because
 * `streamSSE` with ReadableStream over Hono's fetch surface returns
 * the readable but doesn't fan out individual frames synchronously
 * in unit-test scope; the SSE shape itself is exercised live in the
 * e2e harness. Here we assert that the route returns 200 (or the
 * appropriate auth code) and the right Content-Type.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAgentApp } from './app.js';
import { createGuestTokenAuth } from './auth.js';
import { createInMemoryChatStore } from './chat-store.js';
import type {
  AgentAdapter,
  AgentInput,
  NormalizedMessage,
} from './types.js';

const SECRET = 'app-integration-test-secret-32b-ok';

const NOOP_ADAPTER: AgentAdapter = {
  name: 'noop',
  async *run(_input: AgentInput): AsyncIterable<NormalizedMessage> {
    yield {
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] },
    };
    yield { type: 'result', subtype: 'ok' };
  },
};

const MCP_SERVERS = {
  ggui: { url: 'http://localhost:9999/mcp', bearer: 'dev' },
};

function buildApp(): {
  app: ReturnType<typeof createAgentApp>;
  store: ReturnType<typeof createInMemoryChatStore>;
  auth: ReturnType<typeof createGuestTokenAuth>;
} {
  const auth = createGuestTokenAuth({ signingSecret: SECRET });
  const store = createInMemoryChatStore();
  const app = createAgentApp({
    adapter: NOOP_ADAPTER,
    auth,
    chatStore: store,
    mcpServers: MCP_SERVERS,
    systemPrompt: null,
    sandboxProxyUrl: 'http://localhost:7790',
  });
  return { app, store, auth };
}

async function mintGuestBearer(
  app: ReturnType<typeof createAgentApp>,
): Promise<{ guestToken: string; guestId: string }> {
  const res = await app.request('http://localhost/auth/guest', {
    method: 'POST',
  });
  const body = (await res.json()) as { guestToken: string; guestId: string };
  return body;
}

describe('GET /', () => {
  it('returns the manifest without auth', async () => {
    const { app } = buildApp();
    const res = await app.request('http://localhost/');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      name: string;
      sandboxProxyUrl: string;
      mcpServers: Record<string, { url: string }>;
    };
    expect(body.name).toBe('noop');
    expect(body.sandboxProxyUrl).toBe('http://localhost:7790');
    expect(body.mcpServers.ggui?.url).toBe('http://localhost:9999/mcp');
  });
});

describe('GET /agent', () => {
  it('returns 401 with no bearer', async () => {
    const { app } = buildApp();
    const res = await app.request('http://localhost/agent?chatId=chat_x');
    expect(res.status).toBe(401);
  });

  it('returns 400 with bearer but no chatId', async () => {
    const { app } = buildApp();
    const { guestToken } = await mintGuestBearer(app);
    const res = await app.request('http://localhost/agent', {
      headers: { Authorization: `Bearer ${guestToken}` },
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 on unknown chatId', async () => {
    const { app } = buildApp();
    const { guestToken } = await mintGuestBearer(app);
    const res = await app.request(
      'http://localhost/agent?chatId=chat_missing',
      { headers: { Authorization: `Bearer ${guestToken}` } },
    );
    expect(res.status).toBe(404);
  });

  it('returns 200 + snapshot for the chat owner', async () => {
    const { app, store } = buildApp();
    const { guestToken, guestId } = await mintGuestBearer(app);
    store.append({
      chatId: 'chat_owned',
      ownerId: guestId,
      message: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      },
    });
    const res = await app.request(
      'http://localhost/agent?chatId=chat_owned',
      { headers: { Authorization: `Bearer ${guestToken}` } },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      chatId: string;
      messages: NormalizedMessage[];
    };
    expect(body.chatId).toBe('chat_owned');
    expect(body.messages).toHaveLength(1);
  });

  it('returns 403 when chat is owned by another guest', async () => {
    const { app, store } = buildApp();
    const alice = await mintGuestBearer(app);
    const bob = await mintGuestBearer(app);
    store.append({
      chatId: 'chat_alice',
      ownerId: alice.guestId,
      message: {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'hi' }] },
      },
    });
    const res = await app.request(
      'http://localhost/agent?chatId=chat_alice',
      { headers: { Authorization: `Bearer ${bob.guestToken}` } },
    );
    expect(res.status).toBe(403);
  });

  it('re-inlines each render FRESH from the MCP before replay (Problem B)', async () => {
    const { app, store } = buildApp();
    const { guestToken, guestId } = await mintGuestBearer(app);
    // Recorded message carries a STALE inlined resource (record-time
    // HTML — the todo unchecked at first mount). A live ggui_update
    // checked it afterward but never re-baked into this snapshot.
    store.append({
      chatId: 'chat_fresh',
      ownerId: guestId,
      message: {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: [{ type: 'text', text: 'rendered' }],
            },
          ],
        },
        tool_use_result: {
          content: [{ type: 'text', text: 'rendered' }],
          _meta: {
            ui: {
              resourceUri: 'ui://ggui/render/r_1',
              resource: {
                uri: 'ui://ggui/render/r_1',
                mimeType: 'text/html',
                text: '<html>STALE unchecked</html>',
              },
            },
          },
        },
      },
    });
    // MCP resources/read now returns the CURRENT (checked) HTML.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: {
            contents: [
              {
                uri: 'ui://ggui/render/r_1',
                mimeType: 'text/html',
                text: '<html>FRESH checked</html>',
              },
            ],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await app.request('http://localhost/agent?chatId=chat_fresh', {
        headers: { Authorization: `Bearer ${guestToken}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: Array<{
          tool_use_result?: {
            _meta?: { ui?: { resource?: { text?: string } } };
          };
        }>;
      };
      // The replayed message carries the FRESH HTML, not the stale
      // record-time HTML — a fresh resources/read happened.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const replayedText =
        body.messages[0]?.tool_use_result?._meta?.ui?.resource?.text;
      expect(replayedText).toBe('<html>FRESH checked</html>');
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('falls back to recorded HTML when the fresh MCP read fails', async () => {
    const { app, store } = buildApp();
    const { guestToken, guestId } = await mintGuestBearer(app);
    store.append({
      chatId: 'chat_evicted',
      ownerId: guestId,
      message: {
        type: 'user',
        message: { content: [] },
        tool_use_result: {
          _meta: {
            ui: {
              resourceUri: 'ui://ggui/render/r_gone',
              resource: {
                uri: 'ui://ggui/render/r_gone',
                text: '<html>LAST KNOWN</html>',
              },
            },
          },
        },
      },
    });
    // MCP read fails (e.g. TTL-evicted render) — interceptor passes the
    // message through unchanged, preserving the recorded HTML.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { message: 'render not found' },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await app.request(
        'http://localhost/agent?chatId=chat_evicted',
        { headers: { Authorization: `Bearer ${guestToken}` } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        messages: Array<{
          tool_use_result?: {
            _meta?: { ui?: { resource?: { text?: string } } };
          };
        }>;
      };
      const replayedText =
        body.messages[0]?.tool_use_result?._meta?.ui?.resource?.text;
      expect(replayedText).toBe('<html>LAST KNOWN</html>');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("POST /agent { kind:'chat' }", () => {
  it('returns 401 with no bearer', async () => {
    const { app } = buildApp();
    const res = await app.request('http://localhost/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'chat', prompt: 'hi' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 200 + text/event-stream with a valid bearer', async () => {
    const { app } = buildApp();
    const { guestToken } = await mintGuestBearer(app);
    const res = await app.request('http://localhost/agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${guestToken}`,
      },
      body: JSON.stringify({ kind: 'chat', prompt: 'hi' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')?.toLowerCase()).toContain(
      'text/event-stream',
    );
  });

  it('returns 400 on empty prompt', async () => {
    const { app } = buildApp();
    const { guestToken } = await mintGuestBearer(app);
    const res = await app.request('http://localhost/agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${guestToken}`,
      },
      body: JSON.stringify({ kind: 'chat', prompt: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when the kind discriminator is missing', async () => {
    const { app } = buildApp();
    const { guestToken } = await mintGuestBearer(app);
    const res = await app.request('http://localhost/agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${guestToken}`,
      },
      // The pre-discriminator shape `{prompt}` is no longer accepted.
      body: JSON.stringify({ prompt: 'hi' }),
    });
    expect(res.status).toBe(400);
  });

  it('returns 403 when trying to POST to another guests chat', async () => {
    const { app, store } = buildApp();
    const alice = await mintGuestBearer(app);
    const bob = await mintGuestBearer(app);
    store.append({
      chatId: 'chat_alice',
      ownerId: alice.guestId,
      message: { type: 'result', subtype: 'ok' },
    });
    const res = await app.request('http://localhost/agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bob.guestToken}`,
      },
      body: JSON.stringify({ kind: 'chat', prompt: 'hi', chatId: 'chat_alice' }),
    });
    expect(res.status).toBe(403);
  });
});

describe("POST /agent { kind:'tool-call' }", () => {
  it('returns 401 with no bearer', async () => {
    const { app } = buildApp();
    const res = await app.request('http://localhost/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'tool-call', name: 'ggui_x', arguments: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('returns 400 when name is missing', async () => {
    const { app } = buildApp();
    const { guestToken } = await mintGuestBearer(app);
    const res = await app.request('http://localhost/agent', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${guestToken}`,
      },
      body: JSON.stringify({ kind: 'tool-call', arguments: {} }),
    });
    expect(res.status).toBe(400);
  });

  it('relays the tools/call to the MCP and returns the JSON-RPC result as JSON', async () => {
    const { app } = buildApp();
    const { guestToken } = await mintGuestBearer(app);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: 'relayed' }] },
        }),
        { headers: { 'Content-Type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res = await app.request('http://localhost/agent', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${guestToken}`,
        },
        body: JSON.stringify({
          kind: 'tool-call',
          name: 'ggui_runtime_submit_action',
          arguments: { renderId: 'r_1', event: { name: 'click' } },
        }),
      });
      expect(res.status).toBe(200);
      // Not an SSE stream — the relay returns plain JSON.
      expect(res.headers.get('Content-Type')?.toLowerCase()).toContain(
        'application/json',
      );
      const body = (await res.json()) as {
        result?: { content?: Array<{ text?: string }> };
      };
      expect(body.result?.content?.[0]?.text).toBe('relayed');
      // The relay POSTed to the configured ggui MCP URL.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://localhost:9999/mcp');
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('deleted endpoints', () => {
  it('GET /sandbox-proxy-url is gone (404) — sandboxProxyUrl comes from GET /', async () => {
    const { app } = buildApp();
    const res = await app.request('http://localhost/sandbox-proxy-url');
    expect(res.status).toBe(404);
  });

  it('POST /agent/relay/tools-call is gone (404) — folded into POST /agent', async () => {
    const { app } = buildApp();
    const { guestToken } = await mintGuestBearer(app);
    const res = await app.request('http://localhost/agent/relay/tools-call', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${guestToken}`,
      },
      body: JSON.stringify({ name: 'ggui_x', arguments: {} }),
    });
    expect(res.status).toBe(404);
  });

  it('GET /api/renders/:id/state is gone (404) — freshness handled in GET /agent', async () => {
    const { app } = buildApp();
    const { guestToken } = await mintGuestBearer(app);
    const res = await app.request('http://localhost/api/renders/r_1/state', {
      headers: { Authorization: `Bearer ${guestToken}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('/auth/* surface', () => {
  it('mounts POST /auth/guest', async () => {
    const { app } = buildApp();
    const res = await app.request('http://localhost/auth/guest', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
  });

  it('mounts GET /auth/me requiring bearer', async () => {
    const { app } = buildApp();
    const noAuth = await app.request('http://localhost/auth/me');
    expect(noAuth.status).toBe(401);
    const { guestToken, guestId } = await mintGuestBearer(app);
    const withAuth = await app.request('http://localhost/auth/me', {
      headers: { Authorization: `Bearer ${guestToken}` },
    });
    expect(withAuth.status).toBe(200);
    const body = (await withAuth.json()) as {
      principal: { kind: string; guestId?: string };
    };
    expect(body.principal.kind).toBe('guest');
    expect(body.principal.guestId).toBe(guestId);
  });
});
