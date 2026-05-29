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
import { describe, expect, it } from 'vitest';
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
});

describe('POST /agent', () => {
  it('returns 401 with no bearer', async () => {
    const { app } = buildApp();
    const res = await app.request('http://localhost/agent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi' }),
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
      body: JSON.stringify({ prompt: 'hi' }),
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
      body: JSON.stringify({ prompt: '' }),
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
      body: JSON.stringify({ prompt: 'hi', chatId: 'chat_alice' }),
    });
    expect(res.status).toBe(403);
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
