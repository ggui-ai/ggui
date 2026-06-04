/**
 * Tests for the console OAuth-client management routes
 * (`GET/DELETE /ggui/console/oauth-clients`). Phase 1 of the
 * Connected Apps slice — list + revoke, no manual create yet.
 *
 * Lane 3 (in-process fake) — boots a real `createGguiServer` with
 * OAuth + console both enabled, drives endpoints over real HTTP,
 * asserts wire shape + 404/204 boundaries.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import {
  InMemoryAuthAdapter,
  InMemoryRenderStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiServer, type GguiServer } from './server.js';
import { InMemoryOAuthStorage } from './oauth.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

interface Fixture {
  server: GguiServer;
  httpServer: HttpServer;
  url: string;
  storage: InMemoryOAuthStorage;
}

async function bootWithOAuth(opts: {
  oauthEnabled: boolean;
  consoleEnabled?: boolean;
}): Promise<Fixture> {
  const storage = new InMemoryOAuthStorage();
  const server = createGguiServer({
    logger: silentLogger,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    renderChannel: true,
    renderStore: new InMemoryRenderStore(),
    shortCodeIndex: new InMemoryShortCodeIndex(),
    ...(opts.consoleEnabled !== false
      ? { console: { sessionCookie: true } }
      : {}),
    ...(opts.oauthEnabled
      ? { oauth: { storage } }
      : {}),
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  return {
    server,
    httpServer,
    url: `http://127.0.0.1:${addr.port}`,
    storage,
  };
}

describe('GET /ggui/console/oauth-clients', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('returns an empty list when no clients have registered', async () => {
    fx = await bootWithOAuth({ oauthEnabled: true });
    const res = await fetch(`${fx.url}/ggui/console/oauth-clients`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clients: unknown[] };
    expect(body.clients).toEqual([]);
  });

  it('lists every registered client with the projected wire shape', async () => {
    fx = await bootWithOAuth({ oauthEnabled: true });
    await fx.storage.putClient({
      clientId: 'claude-ai-test',
      clientName: 'claude.ai',
      redirectUris: ['https://claude.ai/oauth/callback'],
      createdAt: 1000,
    });
    await fx.storage.putClient({
      clientId: 'cursor-test',
      // No clientName — should serialize as null in the projected shape.
      redirectUris: ['https://cursor.com/cb'],
      createdAt: 2000,
    });
    const res = await fetch(`${fx.url}/ggui/console/oauth-clients`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      clients: Array<{
        clientId: string;
        clientName: string | null;
        redirectUris: string[];
        createdAt: number;
      }>;
    };
    expect(body.clients).toEqual([
      {
        clientId: 'claude-ai-test',
        clientName: 'claude.ai',
        redirectUris: ['https://claude.ai/oauth/callback'],
        createdAt: 1000,
      },
      {
        clientId: 'cursor-test',
        clientName: null,
        redirectUris: ['https://cursor.com/cb'],
        createdAt: 2000,
      },
    ]);
  });

  it('does NOT mount the route when oauth is disabled', async () => {
    fx = await bootWithOAuth({ oauthEnabled: false });
    const res = await fetch(`${fx.url}/ggui/console/oauth-clients`);
    // Express default 404 — the route block is gated by `if
    // (oauthEnabled)` so the URL never matches a registered handler.
    expect(res.status).toBe(404);
  });
});

describe('DELETE /ggui/console/oauth-clients/:clientId', () => {
  let fx: Fixture | null = null;
  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('returns 204 + removes the client from storage', async () => {
    fx = await bootWithOAuth({ oauthEnabled: true });
    await fx.storage.putClient({
      clientId: 'doomed-client',
      redirectUris: ['https://example.com/cb'],
      createdAt: 1000,
    });
    const res = await fetch(
      `${fx.url}/ggui/console/oauth-clients/doomed-client`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(204);
    expect(await fx.storage.getClient('doomed-client')).toBeNull();
  });

  it('is idempotent — 204 even when the clientId never existed', async () => {
    fx = await bootWithOAuth({ oauthEnabled: true });
    const res = await fetch(
      `${fx.url}/ggui/console/oauth-clients/never-registered`,
      { method: 'DELETE' },
    );
    expect(res.status).toBe(204);
  });

  it('does NOT mount the route when oauth is disabled', async () => {
    fx = await bootWithOAuth({ oauthEnabled: false });
    const res = await fetch(`${fx.url}/ggui/console/oauth-clients/anything`, {
      method: 'DELETE',
    });
    expect(res.status).toBe(404);
  });
});
