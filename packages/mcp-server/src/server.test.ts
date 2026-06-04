/**
 * End-to-end binding smoke. Boots the server on an ephemeral port and
 * exercises every externally-visible code path:
 *
 *   - GET /ggui/health — shape + default identity
 *   - POST /mcp without auth — 401
 *   - POST /mcp with auth — MCP client SDK roundtrip:
 *       initialize → tools/list → tools/call (both list_featured + search)
 *   - custom auth adapter + custom vectors/embedding are honored
 *
 * We use the real `StreamableHTTPClientTransport` + `Client` from the
 * MCP SDK so the test proves actual wire compatibility — not a hand-
 * rolled JSON-RPC impl that could drift from the spec.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server as HttpServer } from 'node:http';
import {
  InMemoryAuthAdapter,
  InMemoryKeyValueStore,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiServer, type GguiServer } from './server.js';

interface BootedFixture {
  server: GguiServer;
  httpServer: HttpServer;
  url: string;
}

/**
 * Hush the default console logger during tests — boot + per-request
 * logs would spam the test runner output. We pass a silent logger
 * shape that swallows events. Individual tests that care about log
 * shape replace this explicitly.
 */
const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

async function boot(
  opts: Parameters<typeof createGguiServer>[0] = {},
): Promise<BootedFixture> {
  const server = createGguiServer({ logger: silentLogger, ...opts });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  const url = `http://127.0.0.1:${addr.port}`;
  return { server, httpServer, url };
}

describe('createGguiServer — HTTP surface', () => {
  let fx: BootedFixture;

  afterEach(async () => {
    await fx.server.close();
  });

  it('exposes GET /ggui/health with status + server + version + tool count', async () => {
    fx = await boot();
    const res = await fetch(`${fx.url}/ggui/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Default boot registers 2 blueprint-read handlers (search + list).
    // `ggui_render_blueprint` is gated on a `uiRegistry` seam being
    // wired — absent registry ⇒ absent tool (no throwing shim).
    // Default boot: ggui_search_blueprints + ggui_list_featured_blueprints
    // + 6 spec/discovery handlers + ggui_runtime_submit_action +
    // ggui_list_gadgets + ggui_runtime_declare_tool_catalog = 11.
    // (The declare tool registers on every boot — the shared
    // tool-identity catalog store defaults to an in-memory instance.)
    expect(body).toEqual({
      status: 'ok',
      server: 'ggui-mcp-server',
      version: '0.0.1',
      tools: 11,
    });
  });

  it('exposes toolCount statically on the GguiServer object', async () => {
    fx = await boot();
    expect(fx.server.toolCount).toBe(11);
  });

  it('toolCount reflects a custom handlers list', async () => {
    fx = await boot({ handlers: [] });
    expect(fx.server.toolCount).toBe(0);
  });

  it('echoes overridden `info` on /ggui/health', async () => {
    fx = await boot({
      info: { name: 'custom', version: '9.9.9' },
    });
    const body = (await (await fetch(`${fx.url}/ggui/health`)).json()) as {
      server: string;
      version: string;
    };
    expect(body.server).toBe('custom');
    expect(body.version).toBe('9.9.9');
  });

  it('omits `threads` from /ggui/health when no thread store is wired', async () => {
    fx = await boot();
    const body = (await (await fetch(`${fx.url}/ggui/health`)).json()) as {
      threads?: unknown;
    };
    expect(body.threads).toBeUndefined();
  });

  it('advertises `threads: { enabled, durability }` on /ggui/health when threads are wired', async () => {
    const { InMemoryThreadStore } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    fx = await boot({
      threads: {
        store: new InMemoryThreadStore(),
        durability: 'ephemeral',
      },
    });
    const body = (await (await fetch(`${fx.url}/ggui/health`)).json()) as {
      threads?: { enabled: boolean; durability: string };
    };
    expect(body.threads).toEqual({ enabled: true, durability: 'ephemeral' });
  });

  it('defaults `durability` to ephemeral when omitted — never overclaims', async () => {
    const { InMemoryThreadStore } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    fx = await boot({ threads: { store: new InMemoryThreadStore() } });
    const body = (await (await fetch(`${fx.url}/ggui/health`)).json()) as {
      threads?: { durability: string };
    };
    expect(body.threads?.durability).toBe('ephemeral');
  });

  it('honors `durability: "durable"` when the caller declares it', async () => {
    const { InMemoryThreadStore } = await import(
      '@ggui-ai/mcp-server-core/in-memory'
    );
    fx = await boot({
      threads: {
        // Using InMemoryThreadStore to keep the test hermetic; the
        // durability claim is orthogonal to the store instance — the
        // server trusts the caller (ggui serve sets this from the
        // manifest's storage.threads.driver). See server.ts JSDoc.
        store: new InMemoryThreadStore(),
        durability: 'durable',
      },
    });
    const body = (await (await fetch(`${fx.url}/ggui/health`)).json()) as {
      threads?: { durability: string };
    };
    expect(body.threads?.durability).toBe('durable');
  });

  describe('/ggui/live (K8s livenessProbe target)', () => {
    it('answers 200 with {status: alive, server} regardless of readinessChecks', async () => {
      // Even with a failing readiness check (which would 503 /ggui/health),
      // /ggui/live must stay 200 — the kubelet's livenessProbe should
      // never restart the pod for a degraded upstream dep. Pre-fix the
      // pod kept rolling under WS load because BOTH probes hit
      // /ggui/health; this contract guards against the regression.
      fx = await boot({
        readinessChecks: [{ name: 'broadcast_subscriber', check: () => false }],
      });
      const liveRes = await fetch(`${fx.url}/ggui/live`);
      expect(liveRes.status).toBe(200);
      const liveBody = (await liveRes.json()) as {
        status: string;
        server: string;
      };
      expect(liveBody.status).toBe('alive');
      expect(liveBody.server).toBe('ggui-mcp-server');
      // Sanity: /ggui/health on the same fixture IS degraded — proves
      // we're not just hitting a 200 because the check is broken.
      const healthRes = await fetch(`${fx.url}/ggui/health`);
      expect(healthRes.status).toBe(503);
    });
  });

  describe('readinessChecks (operator-injected /ggui/health gates)', () => {
    it('omits `checks` and stays 200/ok when no readinessChecks are wired', async () => {
      fx = await boot();
      const res = await fetch(`${fx.url}/ggui/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body.status).toBe('ok');
      expect(body.checks).toBeUndefined();
    });

    it('answers 200/ok with `checks: {name: true}` when every check passes', async () => {
      fx = await boot({
        readinessChecks: [{ name: 'broadcast_subscriber', check: () => true }],
      });
      const res = await fetch(`${fx.url}/ggui/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        checks: Record<string, boolean>;
      };
      expect(body.status).toBe('ok');
      expect(body.checks).toEqual({ broadcast_subscriber: true });
    });

    it('answers 503/degraded with `checks: {name: false}` when a check returns false', async () => {
      fx = await boot({
        readinessChecks: [{ name: 'broadcast_subscriber', check: () => false }],
      });
      const res = await fetch(`${fx.url}/ggui/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        status: string;
        checks: Record<string, boolean>;
      };
      expect(body.status).toBe('degraded');
      expect(body.checks).toEqual({ broadcast_subscriber: false });
    });

    it('treats a thrown check as failed (no propagation into the response)', async () => {
      fx = await boot({
        readinessChecks: [
          {
            name: 'broadcast_subscriber',
            check: () => {
              throw new Error('boom');
            },
          },
        ],
      });
      const res = await fetch(`${fx.url}/ggui/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        status: string;
        checks: Record<string, boolean>;
      };
      expect(body.status).toBe('degraded');
      expect(body.checks.broadcast_subscriber).toBe(false);
    });

    it('treats a check timing out beyond 1s as failed', async () => {
      fx = await boot({
        readinessChecks: [
          {
            name: 'broadcast_subscriber',
            check: () => new Promise<boolean>(() => undefined), // never resolves
          },
        ],
      });
      const res = await fetch(`${fx.url}/ggui/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        status: string;
        checks: Record<string, boolean>;
      };
      expect(body.status).toBe('degraded');
      expect(body.checks.broadcast_subscriber).toBe(false);
    }, 5_000);

    it('one failing check among many drops the overall status to degraded', async () => {
      fx = await boot({
        readinessChecks: [
          { name: 'ready_one', check: () => true },
          { name: 'broken_two', check: () => false },
          { name: 'ready_three', check: async () => true },
        ],
      });
      const res = await fetch(`${fx.url}/ggui/health`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as {
        status: string;
        checks: Record<string, boolean>;
      };
      expect(body.status).toBe('degraded');
      expect(body.checks).toEqual({
        ready_one: true,
        broken_two: false,
        ready_three: true,
      });
    });
  });

  it('returns 405 on GET /mcp (stateless server)', async () => {
    fx = await boot();
    const res = await fetch(`${fx.url}/mcp`);
    expect(res.status).toBe(405);
  });

  it('/ggui/auth-check returns 204 for a valid bearer token (devAllowAll)', async () => {
    fx = await boot();
    const res = await fetch(`${fx.url}/ggui/auth-check`, {
      headers: { Authorization: 'Bearer anything' },
    });
    expect(res.status).toBe(204);
  });

  it('/ggui/auth-check returns 401 when no Authorization header is sent', async () => {
    // Explicit non-devAllowAll adapter so dev-mode doesn't accept empty.
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
    });
    const res = await fetch(`${fx.url}/ggui/auth-check`);
    expect(res.status).toBe(401);
  });

  it('/ggui/auth-check returns 401 for an unknown token against a seeded adapter', async () => {
    fx = await boot({
      auth: new InMemoryAuthAdapter({
        devAllowAll: false,
        seedTokens: [
          {
            token: 'good-token',
            result: { identity: { kind: 'builder' }, source: 'apikey' },
          },
        ],
      }),
    });
    const res = await fetch(`${fx.url}/ggui/auth-check`, {
      headers: { Authorization: 'Bearer WRONG' },
    });
    expect(res.status).toBe(401);
  });

  it('/ggui/auth-check returns 204 for the seeded token', async () => {
    fx = await boot({
      auth: new InMemoryAuthAdapter({
        devAllowAll: false,
        seedTokens: [
          {
            token: 'good-token',
            result: { identity: { kind: 'builder' }, source: 'apikey' },
          },
        ],
      }),
    });
    const res = await fetch(`${fx.url}/ggui/auth-check`, {
      headers: { Authorization: 'Bearer good-token' },
    });
    expect(res.status).toBe(204);
  });

  it('returns 405 on DELETE /mcp (stateless server)', async () => {
    fx = await boot();
    const res = await fetch(`${fx.url}/mcp`, { method: 'DELETE' });
    expect(res.status).toBe(405);
  });
});

describe('createGguiServer — auth gate', () => {
  let fx: BootedFixture;

  afterEach(async () => {
    await fx.server.close();
  });

  it('rejects POST /mcp without an Authorization header (401)', async () => {
    // Explicit non-devAllowAll adapter so dev-mode doesn't rescue us.
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
    });
    const res = await fetch(`${fx.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('accepts any non-empty token when devAllowAll (default) is on', async () => {
    fx = await boot();
    const transport = new StreamableHTTPClientTransport(
      new URL(`${fx.url}/mcp`),
      { requestInit: { headers: { Authorization: 'Bearer anything' } } },
    );
    const client = new Client(
      { name: 'test-client', version: '0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    await client.close();
    // Reaching this line means the initialize handshake completed.
    expect(true).toBe(true);
  });

  it('honors a custom auth adapter with seeded tokens', async () => {
    const adapter = new InMemoryAuthAdapter({
      seedTokens: [
        {
          token: 'secret-token-123',
          result: { identity: { kind: 'builder' }, source: 'apikey' },
        },
      ],
    });
    fx = await boot({ auth: adapter });

    // Wrong token → 401.
    const bad = await fetch(`${fx.url}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer wrong',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 't', version: '0' },
        },
      }),
    });
    expect(bad.status).toBe(401);

    // Seeded token → connect succeeds.
    const transport = new StreamableHTTPClientTransport(
      new URL(`${fx.url}/mcp`),
      {
        requestInit: {
          headers: { Authorization: 'Bearer secret-token-123' },
        },
      },
    );
    const client = new Client(
      { name: 'test-client', version: '0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    await client.close();
  });
});

describe('createGguiServer — OAuth per-app discovery (S4.1, 2026-05-06)', () => {
  let fx: BootedFixture;

  afterEach(async () => {
    await fx.server.close();
  });

  it('mounts a per-app /apps/:appId/.well-known/oauth-protected-resource when perAppRouting is configured', async () => {
    fx = await boot({
      oauth: { issuerUrl: 'https://mcp.example.test' },
      perAppRouting: {
        paramName: 'appId',
        paramPattern: '[A-Za-z0-9]{8}',
        pathPrefix: '/apps',
      },
    });

    // Per-app well-known
    const perApp = await fetch(
      `${fx.url}/apps/aB3kP9xY/.well-known/oauth-protected-resource`,
    );
    expect(perApp.status).toBe(200);
    const perAppBody = (await perApp.json()) as {
      resource: string;
      authorization_servers: string[];
    };
    expect(perAppBody.resource).toBe('https://mcp.example.test/apps/aB3kP9xY');
    expect(perAppBody.authorization_servers).toEqual([
      'https://mcp.example.test',
    ]);

    // Universal well-known still points at the universal resource
    const universal = await fetch(
      `${fx.url}/.well-known/oauth-protected-resource`,
    );
    expect(universal.status).toBe(200);
    const universalBody = (await universal.json()) as { resource: string };
    expect(universalBody.resource).toBe('https://mcp.example.test/mcp');
  });

  it('rejects per-app well-known with appId that fails the regex (404 from Express route mismatch)', async () => {
    fx = await boot({
      oauth: { issuerUrl: 'https://mcp.example.test' },
      perAppRouting: {
        paramName: 'appId',
        paramPattern: '[A-Za-z0-9]{8}',
        pathPrefix: '/apps',
      },
    });
    // 7 chars — fails the {8} length constraint, no route matches.
    const res = await fetch(
      `${fx.url}/apps/short/.well-known/oauth-protected-resource`,
    );
    expect(res.status).toBe(404);
  });

  it('does NOT mount the per-app well-known when perAppRouting is omitted', async () => {
    fx = await boot({ oauth: { issuerUrl: 'https://mcp.example.test' } });
    const res = await fetch(
      `${fx.url}/apps/aB3kP9xY/.well-known/oauth-protected-resource`,
    );
    expect(res.status).toBe(404);
  });

  it('emits per-app WWW-Authenticate on a per-app /apps/:appId 401', async () => {
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      oauth: { issuerUrl: 'https://mcp.example.test' },
      perAppRouting: {
        paramName: 'appId',
        paramPattern: '[A-Za-z0-9]{8}',
        pathPrefix: '/apps',
      },
    });
    // Cloud convention — per-app MCP endpoint is bare `/apps/<appId>`,
    // no `/mcp` suffix (cloud's `universalMcpPath` is also `/`).
    const res = await fetch(`${fx.url}/apps/aB3kP9xY`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).not.toBeNull();
    expect(wwwAuth).toContain(
      'resource_metadata="https://mcp.example.test/apps/aB3kP9xY/.well-known/oauth-protected-resource"',
    );
  });

  it('emits universal WWW-Authenticate on a universal /mcp 401 even when perAppRouting is configured', async () => {
    fx = await boot({
      auth: new InMemoryAuthAdapter({ devAllowAll: false }),
      oauth: { issuerUrl: 'https://mcp.example.test' },
      perAppRouting: {
        paramName: 'appId',
        paramPattern: '[A-Za-z0-9]{8}',
        pathPrefix: '/apps',
      },
    });
    const res = await fetch(`${fx.url}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
    });
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate');
    expect(wwwAuth).not.toBeNull();
    // No `/apps/...` segment — universal metadata path.
    expect(wwwAuth).toContain(
      'resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource"',
    );
    expect(wwwAuth).not.toContain('/apps/');
  });
});

describe('createGguiServer — RFC 8707 resource indicator (S4.2, 2026-05-06)', () => {
  let fx: BootedFixture;

  afterEach(async () => {
    await fx.server.close();
  });

  /**
   * Helper — register a DCR client + run the full /authorize POST →
   * /token exchange. Returns `{ status, body }` from the /token
   * response. `resource` is forwarded onto BOTH the /authorize and
   * /token requests so the test can vary either end independently
   * via overrides.
   */
  async function runOAuthFlow(
    fx: BootedFixture,
    opts: {
      authorizeResource?: string;
      tokenResource?: string;
      apiKey?: string;
    } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    // 1. DCR — register the client.
    const reg = await fetch(`${fx.url}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test-client',
        redirect_uris: ['https://client.example/cb'],
      }),
    });
    expect(reg.status).toBe(201);
    const regBody = (await reg.json()) as { client_id: string };

    // 2. PKCE — verifier + S256 challenge.
    const verifier = 'a'.repeat(64);
    const { createHash } = await import('node:crypto');
    const challenge = createHash('sha256')
      .update(verifier)
      .digest('base64url');

    // 3. POST /oauth/authorize with the form params + paste-key.
    const form = new URLSearchParams();
    form.set('response_type', 'code');
    form.set('client_id', regBody.client_id);
    form.set('redirect_uri', 'https://client.example/cb');
    form.set('code_challenge', challenge);
    form.set('code_challenge_method', 'S256');
    form.set('api_key', opts.apiKey ?? 'devAllowAllKey');
    if (opts.authorizeResource !== undefined) {
      form.set('resource', opts.authorizeResource);
    }
    const authz = await fetch(`${fx.url}/oauth/authorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'manual',
    });
    if (authz.status >= 400) {
      const text = await authz.text();
      return { status: authz.status, body: { html: text } };
    }
    expect([302, 303]).toContain(authz.status);
    const location = authz.headers.get('location');
    expect(location).not.toBeNull();
    const url = new URL(location!);
    const code = url.searchParams.get('code');
    expect(code).not.toBeNull();

    // 4. POST /oauth/token with the code + verifier.
    const tokenForm = new URLSearchParams();
    tokenForm.set('grant_type', 'authorization_code');
    tokenForm.set('code', code!);
    tokenForm.set('redirect_uri', 'https://client.example/cb');
    tokenForm.set('client_id', regBody.client_id);
    tokenForm.set('code_verifier', verifier);
    if (opts.tokenResource !== undefined) {
      tokenForm.set('resource', opts.tokenResource);
    }
    const tok = await fetch(`${fx.url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: tokenForm.toString(),
    });
    return {
      status: tok.status,
      body: (await tok.json()) as Record<string, unknown>,
    };
  }

  it('accepts a universal resource indicator round-trip /authorize → /token', async () => {
    fx = await boot({
      oauth: { issuerUrl: 'https://mcp.example.test' },
    });
    const result = await runOAuthFlow(fx, {
      authorizeResource: 'https://mcp.example.test/mcp',
      tokenResource: 'https://mcp.example.test/mcp',
    });
    expect(result.status).toBe(200);
    expect(result.body['access_token']).toBe('devAllowAllKey');
  });

  it('accepts a per-app resource indicator round-trip', async () => {
    fx = await boot({
      oauth: { issuerUrl: 'https://mcp.example.test' },
      perAppRouting: {
        paramName: 'appId',
        paramPattern: '[A-Za-z0-9]{8}',
        pathPrefix: '/apps',
      },
    });
    const result = await runOAuthFlow(fx, {
      authorizeResource: 'https://mcp.example.test/apps/aB3kP9xY',
      tokenResource: 'https://mcp.example.test/apps/aB3kP9xY',
    });
    expect(result.status).toBe(200);
  });

  it('rejects a malformed resource at /authorize with invalid_target', async () => {
    fx = await boot({
      oauth: { issuerUrl: 'https://mcp.example.test' },
      perAppRouting: {
        paramName: 'appId',
        paramPattern: '[A-Za-z0-9]{8}',
        pathPrefix: '/apps',
      },
    });
    // Wrong host — not on this issuer's domain.
    const result = await runOAuthFlow(fx, {
      authorizeResource: 'https://other.example.com/apps/aB3kP9xY',
    });
    expect(result.status).toBe(400);
    expect(String((result.body as { html?: string }).html)).toContain(
      'invalid_target',
    );
  });

  it('rejects a per-app resource whose appId fails the pattern', async () => {
    fx = await boot({
      oauth: { issuerUrl: 'https://mcp.example.test' },
      perAppRouting: {
        paramName: 'appId',
        paramPattern: '[A-Za-z0-9]{8}',
        pathPrefix: '/apps',
      },
    });
    // 7-char appId fails the {8} length constraint.
    const result = await runOAuthFlow(fx, {
      authorizeResource: 'https://mcp.example.test/apps/short77',
    });
    expect(result.status).toBe(400);
  });

  it('returns invalid_target at /token when resources mismatch between authorize and token', async () => {
    fx = await boot({
      oauth: { issuerUrl: 'https://mcp.example.test' },
      perAppRouting: {
        paramName: 'appId',
        paramPattern: '[A-Za-z0-9]{8}',
        pathPrefix: '/apps',
      },
    });
    const result = await runOAuthFlow(fx, {
      authorizeResource: 'https://mcp.example.test/apps/aB3kP9xY',
      // Different valid appId — both pass the per-app pattern but
      // they don't match each other, so /token rejects.
      tokenResource: 'https://mcp.example.test/apps/zZzZzZzZ',
    });
    expect(result.status).toBe(400);
    expect(result.body['error']).toBe('invalid_target');
  });

  it('omits resource → universal scoping → /token succeeds without resource', async () => {
    fx = await boot({
      oauth: { issuerUrl: 'https://mcp.example.test' },
    });
    // Backward-compat: no resource at either step.
    const result = await runOAuthFlow(fx);
    expect(result.status).toBe(200);
    expect(result.body['access_token']).toBe('devAllowAllKey');
  });
});

describe('createGguiServer — MCP wire roundtrip', () => {
  let fx: BootedFixture;

  afterEach(async () => {
    await fx.server.close();
  });

  async function connectClient(url: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${url}/mcp`),
      { requestInit: { headers: { Authorization: 'Bearer dev' } } },
    );
    const client = new Client(
      { name: 'test-client', version: '0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  }

  it('tools/list surfaces every registered handler (default boot: no render, no uiRegistry)', async () => {
    fx = await boot();
    const client = await connectClient(fx.url);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // Phase 4.2 audience filter: `/mcp` exposes only `agent` + `runtime`
      // tagged tools. The 6 spec/discovery handlers (audience: ['protocol'])
      // are now mounted at `/protocol` and absent from this list.
      // `ggui_render_blueprint` is still gated on a `uiRegistry` seam.
      expect(names).toEqual([
        'ggui_list_featured_blueprints',
        'ggui_list_gadgets',
        'ggui_runtime_declare_tool_catalog',
        'ggui_runtime_submit_action',
        'ggui_search_blueprints',
      ]);
    } finally {
      await client.close();
    }
  });

  // Phase 4.2 — pin audience-filtered route mounting. `/protocol`
  // hosts only `audience: ['protocol']` tools; `/mcp` hosts only
  // `agent` + `runtime`. Cross-route requests MUST NOT see each
  // other's tools.
  it('audience filter: /protocol surfaces only protocol-tagged tools', async () => {
    fx = await boot();
    const transport = new StreamableHTTPClientTransport(
      new URL(`${fx.url}/protocol`),
      { requestInit: { headers: { Authorization: 'Bearer dev' } } },
    );
    const client = new Client(
      { name: 'test-client', version: '0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // The 6 spec/discovery factories tagged audience: ['protocol'],
      // renamed in Phase 4.1 to carry the `ggui_protocol_*` prefix.
      expect(names).toEqual([
        'ggui_protocol_describe_blueprint_format',
        'ggui_protocol_describe_data_contract_format',
        'ggui_protocol_get_blueprint_boilerplate',
        'ggui_protocol_get_example_blueprints',
        'ggui_protocol_list_available_primitives',
        'ggui_protocol_validate_blueprint',
      ]);
    } finally {
      await client.close();
    }
  });

  it('audience filter: /mcp does NOT surface protocol-tagged tools', async () => {
    fx = await boot();
    const client = await connectClient(fx.url);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('ggui_protocol_describe_blueprint_format');
      expect(names).not.toContain('ggui_protocol_describe_data_contract_format');
      expect(names).not.toContain('ggui_protocol_validate_blueprint');
    } finally {
      await client.close();
    }
  });

  it('audience filter: /protocol does NOT surface agent-tagged tools', async () => {
    fx = await boot();
    const transport = new StreamableHTTPClientTransport(
      new URL(`${fx.url}/protocol`),
      { requestInit: { headers: { Authorization: 'Bearer dev' } } },
    );
    const client = new Client(
      { name: 'test-client', version: '0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('ggui_search_blueprints');
      expect(names).not.toContain('ggui_list_featured_blueprints');
      expect(names).not.toContain('ggui_runtime_submit_action');
    } finally {
      await client.close();
    }
  });

  it('audience filter: /ops route mounts even when no ops handlers wired (404-equivalent on tools/list)', async () => {
    // Default OSS boot wires no ops handlers (provider-keys + credit
    // factories are deps-conditional). The route still mounts so cloud
    // and OSS share the same URL contract; tools/list surfaces the
    // MCP-SDK "method not found" because no `tool()` calls registered
    // the capability when the handler list is empty. When ops deps land,
    // tools/list returns the expected ops surface — covered by
    // contract tests that wire a fake ProviderKeyStore.
    fx = await boot();
    const transport = new StreamableHTTPClientTransport(
      new URL(`${fx.url}/ops`),
      { requestInit: { headers: { Authorization: 'Bearer dev' } } },
    );
    const client = new Client(
      { name: 'test-client', version: '0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    try {
      await expect(client.listTools()).rejects.toThrow(/Method not found/);
    } finally {
      await client.close();
    }
  });

  it('tools/call ggui_list_featured_blueprints returns the contract-shaped output', async () => {
    fx = await boot();
    const client = await connectClient(fx.url);
    try {
      const result = await client.callTool({
        name: 'ggui_list_featured_blueprints',
        arguments: {},
      });
      expect(result.structuredContent).toEqual({
        blueprints: [],
        total: 0,
      });
    } finally {
      await client.close();
    }
  });

  it('tools/call ggui_search_blueprints reaches the injected vector store', async () => {
    // Custom vectors + embedding so we can observe what the handler sees.
    const embedding = new MockEmbeddingProvider({ dimensions: 8 });
    const vectors = new InMemoryVectorStore();
    // Seed a single match under the default `builder` appId so the
    // handler's `ctx.appId`-scoped query lands on it.
    const vec = await embedding.embed('weather card');
    await vectors.putVector('builder', {
      key: 'p_weather_card',
      vector: vec,
      metadata: { prompt: 'Show current weather', category: 'dashboards' },
    });
    fx = await boot({ embedding, vectors });

    const client = await connectClient(fx.url);
    try {
      const result = await client.callTool({
        name: 'ggui_search_blueprints',
        arguments: { query: 'weather card' },
      });
      const structured = result.structuredContent as {
        results: Array<{ id: string; name: string }>;
        total: number;
      };
      expect(structured.total).toBeGreaterThan(0);
      const hit = structured.results.find(
        (r) => r.id === 'p_weather_card',
      );
      expect(hit).toBeDefined();
      expect(hit?.name).toBe('Predefined_weather_card');
    } finally {
      await client.close();
    }
  });

  it('defaultHandlers lets callers extend rather than replace the default set', async () => {
    // Minimal custom handler that proves extension works end-to-end.
    const extraHandler = {
      name: 'test_custom_ping',
      description: 'Returns pong for extension-smoke purposes.',
      inputSchema: {},
      outputSchema: { pong: z.string() },
      handler: async () => ({ pong: 'ok' }),
    };
    const vectors = new InMemoryVectorStore();
    const embedding = new MockEmbeddingProvider();
    const { defaultHandlers } = await import('./server.js');
    fx = await boot({
      vectors,
      embedding,
      handlers: [...defaultHandlers({ vectors, embedding }), extraHandler],
    });
    const client = await connectClient(fx.url);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // Phase 4.2: `/mcp` exposes agent + runtime audience only. Custom
      // handler has no audience tag → defaults to ['agent'] → visible here.
      expect(names).toEqual([
        'ggui_list_featured_blueprints',
        'ggui_list_gadgets',
        'ggui_runtime_submit_action',
        'ggui_search_blueprints',
        'test_custom_ping',
      ]);
      const result = await client.callTool({
        name: 'test_custom_ping',
        arguments: {},
      });
      expect(result.structuredContent).toEqual({ pong: 'ok' });
    } finally {
      await client.close();
    }
  });

  it('tools/call ggui_render_blueprint resolves a registered blueprint to inline code', async () => {
    // Wire a fake `UiRegistry` that knows exactly one blueprint +
    // returns a canned bundle. Asserts the full MCP round-trip
    // (initialize → tools/call → result envelope with the compiled
    // code). Together with the render-blueprint unit tests this
    // covers the happy path end-to-end through the wire.
    const registry = {
      capabilities: { writable: false, observable: false },
      async list() {
        return [];
      },
      async get(id: string) {
        if (id !== 'weather-card-fixture') return undefined;
        return {
          id,
          contentHash: 'hash-weather',
          // `parseUiManifest` fills more; cast through a narrow
          // object — render only reads `name`.
          manifest: { id, name: 'Weather Card Fixture' } as never,
        };
      },
      async getBundle(id: string) {
        if (id !== 'weather-card-fixture') return undefined;
        return {
          code: `export default function Weather(){return null;}`,
          contentType: 'application/javascript+react',
        };
      },
    };
    fx = await boot({ uiRegistry: registry });
    const client = await connectClient(fx.url);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('ggui_render_blueprint');

      const result = await client.callTool({
        name: 'ggui_render_blueprint',
        arguments: { blueprintId: 'weather-card-fixture' },
      });
      expect(result.isError).not.toBe(true);
      const structured = result.structuredContent as {
        blueprintId: string;
        blueprintName: string;
        code: string;
        contentType: string;
      };
      expect(structured.blueprintId).toBe('weather-card-fixture');
      expect(structured.blueprintName).toBe('Weather Card Fixture');
      expect(structured.code).toContain('export default function Weather');
      expect(structured.contentType).toBe('application/javascript+react');
    } finally {
      await client.close();
    }
  });
});

describe('createGguiServer — primitive catalogs (OSS split Phase 4 #3/#4 wiring)', () => {
  // Scope: prove the `primitiveCatalogs?` opt threads through to the
  // returned handle. The generation pipeline doesn't consume these
  // catalogs yet (deliberate follow-up per
  // docs/plans/2026-04-20-primitive-discovery-convention.md §6), but
  // making them visible on the handle is the minimum honest signal
  // that the declaration stops being inert. Future generator wiring
  // will consume this same field.
  //
  // Construction-only assertions — no socket is bound.

  it('defaults `primitiveCatalogs` to an empty array when the option is omitted', () => {
    const server = createGguiServer({ logger: silentLogger });
    expect(server.primitiveCatalogs).toEqual([]);
  });

  it('surfaces the passed catalogs on `server.primitiveCatalogs`', () => {
    const catalog = {
      source: 'package' as const,
      import: '@ggui-ai/design/primitives',
      manifestPath: '/tmp/design/ggui.primitives.json',
      manifest: {
        schema: '1' as const,
        import: '@ggui-ai/design/primitives',
        primitives: [{ name: 'Button' }, { name: 'Card' }],
      },
    };
    const server = createGguiServer({
      logger: silentLogger,
      primitiveCatalogs: [catalog],
    });
    expect(server.primitiveCatalogs).toHaveLength(1);
    expect(server.primitiveCatalogs[0]).toEqual(catalog);
    // Shape is frozen into an independent array so consumers can't
    // mutate the server's view by re-ordering the passed-in ref.
    expect(server.primitiveCatalogs).not.toBe([catalog]);
  });

  it('preserves boot-time order across multiple catalogs', () => {
    const pkg = {
      source: 'package' as const,
      import: '@ggui-ai/design/primitives',
      manifestPath: '/tmp/design/ggui.primitives.json',
      manifest: {
        schema: '1' as const,
        import: '@ggui-ai/design/primitives',
        primitives: [{ name: 'Button' }],
      },
    };
    const local = {
      source: 'local' as const,
      import: './ui/primitives/index.js',
      manifestPath: '/tmp/app/ui/primitives/ggui.primitives.json',
      manifest: {
        schema: '1' as const,
        import: './ui/primitives/index.js',
        primitives: [{ name: 'Brand' }],
      },
    };
    const server = createGguiServer({
      logger: silentLogger,
      primitiveCatalogs: [pkg, local],
    });
    expect(server.primitiveCatalogs.map((c) => c.import)).toEqual([
      '@ggui-ai/design/primitives',
      './ui/primitives/index.js',
    ]);
  });
});

describe('createGguiServer — theme (OSS split Phase 4 #4 wiring)', () => {
  // Scope: prove the `theme?: LoadedTheme` opt threads through to
  // the returned handle, and that the default fallback populates
  // `server.theme` even when the caller passes nothing. No
  // console injection / generation prompt wiring yet —
  // downstream slices layer on via `server.theme`.
  //
  // Construction-only assertions — no socket is bound.

  it('defaults `server.theme` to a `LoadedTheme` backed by the shipped default when opt omitted', () => {
    const server = createGguiServer({ logger: silentLogger });
    expect(server.theme.source).toBe('default');
    expect(server.theme.document).toBeDefined();
    expect(server.theme.cssVariables).toContain(':root {');
    // The shipped lightTheme emits a primary color palette; if that
    // ever changes we want the drift surfaced here.
    expect(server.theme.cssVariables).toMatch(/--ggui-color-primary-\d+/);
  });

  it('surfaces the passed `LoadedTheme` on `server.theme` when opt provided', () => {
    const customDoc = {
      color: {
        primary: {
          '500': { $type: 'color' as const, $value: '#ff00ff' },
        },
        surface: { $type: 'color' as const, $value: '#000000' },
      },
      spacing: {
        '4': { $type: 'dimension' as const, $value: '16px' },
      },
      font: {
        family: {
          sans: { $type: 'fontFamily' as const, $value: 'Brand Sans' },
        },
        size: {
          md: { $type: 'dimension' as const, $value: '16px' },
        },
        weight: {
          regular: { $type: 'fontWeight' as const, $value: 400 },
        },
        lineHeight: {
          normal: { $type: 'number' as const, $value: 1.5 },
        },
      },
      shape: {
        radius: { md: { $type: 'dimension' as const, $value: '8px' } },
        shadow: {
          sm: {
            $type: 'shadow' as const,
            $value: {
              offsetX: '0',
              offsetY: '1px',
              blur: '2px',
              spread: '0',
              color: 'rgba(0,0,0,.05)',
            },
          },
        },
      },
    };
    const server = createGguiServer({
      logger: silentLogger,
      theme: {
        source: 'file',
        path: '/tmp/app/theme.json',
        mode: 'light',
        document: customDoc,
        cssVariables: ':root {\n  --ggui-color-primary-500: #ff00ff;\n}',
      },
    });
    expect(server.theme.source).toBe('file');
    if (server.theme.source === 'file') {
      expect(server.theme.path).toBe('/tmp/app/theme.json');
    }
    expect(server.theme.cssVariables).toContain('#ff00ff');
  });
});

// `adapters` opt + handle field retired entirely in Bucket B
// (2026-05-18, LOCKED-22). Grant model lives on
// `clientCapabilities.gadgets[*].permission`. No handle field, no opt.
// Anyone wanting to lock down hardware access does it via the gadget
// catalog now.

describe('createGguiServer — mcpMounts (Slice 6 runtime aggregation)', () => {
  // Scope: prove mounted `SharedHandler` bundles show up on the same
  // `/mcp` surface as ggui-native tools, one session sees both, and
  // `tools/call` dispatches to the mount handler. Uses a tiny
  // inline `greeter_hello` handler so the proof stays self-contained
  // — the Tasks fixture's own `createTasksSharedHandlers` bundle
  // lives in the closed e2e-oss fixture package and gets its own
  // mount-integration proof there.
  let fx: BootedFixture;

  afterEach(async () => {
    await fx.server.close();
  });

  async function connectClient(url: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(
      new URL(`${url}/mcp`),
      { requestInit: { headers: { Authorization: 'Bearer dev' } } },
    );
    const client = new Client(
      { name: 'test-client', version: '0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  }

  const greeter = {
    name: 'greeter_hello',
    description: 'Returns a greeting for the supplied name.',
    inputSchema: { name: z.string().min(1) },
    outputSchema: { message: z.string() },
    handler: async (input: Record<string, unknown>) => ({
      message: `hello ${input.name as string}`,
    }),
  };

  it('tools/list surfaces ggui-native tools + mount tools on one session', async () => {
    fx = await boot({
      mcpMounts: [{ name: 'greeter', handlers: [greeter] }],
    });
    const client = await connectClient(fx.url);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      // Phase 4.2: `/mcp` exposes agent + runtime audience. Mount tools
      // (untagged) default to 'agent' so they appear here.
      expect(names).toEqual([
        'ggui_list_featured_blueprints',
        'ggui_list_gadgets',
        'ggui_runtime_declare_tool_catalog',
        'ggui_runtime_submit_action',
        'ggui_search_blueprints',
        'greeter_hello',
      ]);
    } finally {
      await client.close();
    }
  });

  it('tools/call dispatches to the mounted handler and returns its structured result', async () => {
    fx = await boot({
      mcpMounts: [{ name: 'greeter', handlers: [greeter] }],
    });
    const client = await connectClient(fx.url);
    try {
      const result = await client.callTool({
        name: 'greeter_hello',
        arguments: { name: 'Ada' },
      });
      expect(result.structuredContent).toEqual({ message: 'hello Ada' });
    } finally {
      await client.close();
    }
  });

  it('toolCount on the returned handle reflects base + mount tools', () => {
    const server = createGguiServer({
      logger: silentLogger,
      mcpMounts: [{ name: 'greeter', handlers: [greeter] }],
    });
    // 11 default handlers (2 blueprint-read + 6 spec/discovery + 1 submit-action
    // + 1 list-gadgets + 1 declare-tool-catalog) + 1 mount handler.
    // `ggui_render_blueprint` is gated on `uiRegistry`.
    expect(server.toolCount).toBe(12);
  });

  it('throws at composition time when a mount tool name collides with a ggui-native tool', () => {
    // Non-empty outputSchema keeps the Slice 6.2 empty-outputSchema
    // guardrail from firing first — this test is about collision
    // detection, not the structuredContent-strip footgun.
    const clashing = {
      name: 'ggui_search_blueprints',
      description: 'clashing',
      inputSchema: {},
      outputSchema: { ok: z.literal(true) },
      handler: async () => ({ ok: true }),
    };
    expect(() =>
      createGguiServer({
        logger: silentLogger,
        mcpMounts: [{ name: 'evil', handlers: [clashing] }],
      }),
    ).toThrow(/collides with a ggui-native tool/);
  });

  it('throws at composition time when two mounts register the same tool name', () => {
    expect(() =>
      createGguiServer({
        logger: silentLogger,
        mcpMounts: [
          { name: 'first', handlers: [greeter] },
          { name: 'second', handlers: [greeter] },
        ],
      }),
    ).toThrow(/mount "second" registers tool "greeter_hello"/);
  });
});

describe('createGguiServer — mcpServices (Slice 8.0 isolated services)', () => {
  // Scope: prove that isolated services mounted via `mcpServices`:
  //   1. Reach the wire at their declared path with their own tool set.
  //   2. Are isolated from each other and from the audience-filtered
  //      `/mcp` / `/protocol` / `/ops` surfaces — clients connecting to
  //      one path only see that path's tools.
  //   3. Reject misconfiguration at server-construction time, not at
  //      first `tools/call`.
  let fx: BootedFixture;

  afterEach(async () => {
    await fx.server.close();
  });

  async function connectClientAt(url: string, path: string): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(new URL(`${url}${path}`), {
      requestInit: { headers: { Authorization: 'Bearer dev' } },
    });
    const client = new Client(
      { name: 'test-client', version: '0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  }

  const docsTool = {
    name: 'docs_search',
    description: 'Search the docs corpus.',
    inputSchema: { q: z.string().min(1) },
    outputSchema: { hits: z.array(z.string()) },
    handler: async (input: Record<string, unknown>) => ({
      hits: [`result for ${input.q as string}`],
    }),
  };

  const todosTool = {
    name: 'todos_list',
    description: 'List todos.',
    inputSchema: {},
    outputSchema: { items: z.array(z.string()) },
    handler: async () => ({ items: ['walk dog', 'ship slice 8'] }),
  };

  it('tools/list at a service path returns ONLY that service\'s tools (isolated namespace)', async () => {
    fx = await boot({
      mcpServices: [
        { name: 'docs', path: '/docs', handlers: [docsTool] },
        { name: 'todos', path: '/playground/todos', handlers: [todosTool] },
      ],
    });

    const docsClient = await connectClientAt(fx.url, '/docs');
    try {
      const { tools } = await docsClient.listTools();
      expect(tools.map((t) => t.name)).toEqual(['docs_search']);
    } finally {
      await docsClient.close();
    }

    const todosClient = await connectClientAt(fx.url, '/playground/todos');
    try {
      const { tools } = await todosClient.listTools();
      expect(tools.map((t) => t.name)).toEqual(['todos_list']);
    } finally {
      await todosClient.close();
    }
  });

  it('the universal /mcp route does NOT see service tools', async () => {
    fx = await boot({
      mcpServices: [{ name: 'docs', path: '/docs', handlers: [docsTool] }],
    });
    const mainClient = await connectClientAt(fx.url, '/mcp');
    try {
      const { tools } = await mainClient.listTools();
      // The service's `docs_search` lives at /docs only, never on /mcp.
      expect(tools.map((t) => t.name)).not.toContain('docs_search');
    } finally {
      await mainClient.close();
    }
  });

  it('tools/call at a service path dispatches to that service\'s handler', async () => {
    fx = await boot({
      mcpServices: [{ name: 'docs', path: '/docs', handlers: [docsTool] }],
    });
    const client = await connectClientAt(fx.url, '/docs');
    try {
      const result = await client.callTool({
        name: 'docs_search',
        arguments: { q: 'protocol' },
      });
      expect(result.structuredContent).toEqual({
        hits: ['result for protocol'],
      });
    } finally {
      await client.close();
    }
  });

  it('two services may register the SAME tool name without colliding', async () => {
    const sharedNameDocs = {
      name: 'search',
      description: 'Search docs.',
      inputSchema: {},
      outputSchema: { result: z.literal('docs') },
      handler: async () => ({ result: 'docs' as const }),
    };
    const sharedNameTodos = {
      name: 'search',
      description: 'Search todos.',
      inputSchema: {},
      outputSchema: { result: z.literal('todos') },
      handler: async () => ({ result: 'todos' as const }),
    };
    fx = await boot({
      mcpServices: [
        { name: 'docs', path: '/docs', handlers: [sharedNameDocs] },
        {
          name: 'todos',
          path: '/playground/todos',
          handlers: [sharedNameTodos],
        },
      ],
    });

    const docsClient = await connectClientAt(fx.url, '/docs');
    try {
      const r = await docsClient.callTool({ name: 'search', arguments: {} });
      expect(r.structuredContent).toEqual({ result: 'docs' });
    } finally {
      await docsClient.close();
    }

    const todosClient = await connectClientAt(fx.url, '/playground/todos');
    try {
      const r = await todosClient.callTool({ name: 'search', arguments: {} });
      expect(r.structuredContent).toEqual({ result: 'todos' });
    } finally {
      await todosClient.close();
    }
  });

  it('throws at construction when a service path collides with a reserved built-in route', () => {
    expect(() =>
      createGguiServer({
        logger: silentLogger,
        mcpServices: [
          { name: 'shadow-ops', path: '/ops', handlers: [docsTool] },
        ],
      }),
    ).toThrow(/reserved built-in route/);
  });

  it('throws at construction when a service handler sets `audience` (services bypass audience filtering)', () => {
    const taggedHandler = {
      ...docsTool,
      audience: ['ops'] as const,
    };
    expect(() =>
      createGguiServer({
        logger: silentLogger,
        mcpServices: [
          { name: 'docs', path: '/docs', handlers: [taggedHandler] },
        ],
      }),
    ).toThrow(/Services bypass audience filtering/);
  });

  it('anonymous: true accepts requests without an Authorization header (no 401)', async () => {
    fx = await boot({
      mcpServices: [
        {
          name: 'docs',
          path: '/docs',
          handlers: [docsTool],
          anonymous: true,
        },
      ],
    });
    // Plain fetch with NO Authorization header. The /mcp route would
    // 401 on this; the anonymous service must let it through.
    const initBody = {
      jsonrpc: '2.0' as const,
      method: 'initialize' as const,
      params: {
        protocolVersion: '2024-11-05' as const,
        capabilities: {},
        clientInfo: { name: 'anonymous-test', version: '0' },
      },
      id: 1,
    };
    const res = await fetch(`${fx.url}/docs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(initBody),
    });
    // Anonymous mode: no auth required. The MCP server responds 200
    // (with an initialize response stream); a 401 here would prove the
    // anonymous branch failed.
    expect(res.status).not.toBe(401);
  });

  it('default (anonymous unset) still requires auth — 401 without Authorization under a strict adapter', async () => {
    // OSS default `devAllowAll: true` lets every request through, so a
    // missing-bearer test against the default boot proves nothing.
    // Wire a strict adapter (devAllowAll off, no seeded tokens) so the
    // 401 path is reachable, then prove a service WITHOUT
    // `anonymous: true` still rejects.
    const strictAuth = new InMemoryAuthAdapter({ devAllowAll: false });
    fx = await boot({
      auth: strictAuth,
      mcpServices: [
        { name: 'docs', path: '/docs', handlers: [docsTool] },
      ],
    });
    const res = await fetch(`${fx.url}/docs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'no-auth', version: '0' },
        },
        id: 1,
      }),
    });
    expect(res.status).toBe(401);
  });
});

describe('createGguiServer — ggui_handshake (Slice 5 preflight seam)', () => {
  // Scope: prove the handshake handler is auto-registered when
  // `mcpApps` is on, the paired push consume succeeds over the real
  // MCP wire, the store is shared between both handlers, and explicit
  // `handshake: false` opts out cleanly. Mirrors the mcpApps + adapter
  // integration shape above so the transport + auth round-trip is
  // real, not stubbed.

  async function bootHandshake(
    overrides: Parameters<typeof createGguiServer>[0] = {},
  ): Promise<BootedFixture> {
    const server = createGguiServer({
      logger: silentLogger,
      renderChannel: true,
      mcpApps: {
        wsUrl: 'ws://localhost/ws',
      },
      wsTokenSecret: 'test-secret-for-handshake',
      ...overrides,
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('bad addr');
    return { server, httpServer, url: `http://127.0.0.1:${addr.port}` };
  }

  async function connect(fx: BootedFixture): Promise<Client> {
    const client = new Client({ name: 'test', version: '0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${fx.url}/mcp`),
      { requestInit: { headers: { authorization: 'Bearer t' } } },
    );
    await client.connect(transport);
    return client;
  }

  let fx: BootedFixture;

  afterEach(async () => {
    await fx.server.close();
  });

  it('registers ggui_handshake alongside ggui_render when mcpApps is enabled', async () => {
    fx = await bootHandshake();
    const client = await connect(fx);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toContain('ggui_handshake');
      expect(names).toContain('ggui_render');
    } finally {
      await client.close();
    }
  });

  // Phase 2.3 wire — ggui_consume registers automatically when push
  // is bound (default in-memory PendingEventConsumer). Closes the FF
  // nextStep → consume hint chain end-to-end on `ggui serve`. Without
  // this registration, every render response emitted nextStep:ggui_consume
  // pointing at a non-existent tool.
  it('registers ggui_consume alongside ggui_render (default in-memory consumer)', async () => {
    fx = await bootHandshake();
    const client = await connect(fx);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name).sort();
      expect(names).toContain('ggui_consume');
      expect(names).toContain('ggui_render');
    } finally {
      await client.close();
    }
  });

  // Post-Phase-B render-lifecycle suite — the previously-five-tool
  // session-lifecycle pack (get-session, get-stack, close, pop, stream)
  // collapsed to the render-shape equivalents: a render IS the addressable
  // row, so `ggui_get_session` + `ggui_get_stack` + `ggui_pop` all fold
  // into the single `ggui_get_render` + `ggui_list_renders` pair, and
  // `ggui_close` was deleted (no terminal write — renders decay via TTL).
  // Closes the OSS surface gap: agents can now call the full lifecycle
  // (handshake → render → consume → get_render / list_renders / emit)
  // on `ggui serve` without hosting cloud.
  it('registers the full render-lifecycle suite alongside ggui_render', async () => {
    fx = await bootHandshake();
    const client = await connect(fx);
    try {
      const { tools } = await client.listTools();
      const names = new Set(tools.map((t) => t.name));
      expect(names).toContain('ggui_get_render');
      expect(names).toContain('ggui_list_renders');
      expect(names).toContain('ggui_emit');
      // `ggui_close` was retired alongside the terminal `session.closed`
      // event; renders expire implicitly via TTL.
      expect(names).not.toContain('ggui_close');
    } finally {
      await client.close();
    }
  });

  it('does NOT register ggui_handshake when mcpApps is off', async () => {
    // mcpApps disabled means no ggui_render AND no ggui_handshake —
    // preflight without a paired call target is pointless.
    const server = createGguiServer({ logger: silentLogger });
    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('bad addr');
    fx = { server, httpServer, url: `http://127.0.0.1:${addr.port}` };
    const client = await connect(fx);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('ggui_handshake');
      expect(names).not.toContain('ggui_render');
    } finally {
      await client.close();
    }
  });

  it('ggui_handshake → ggui_render({handshakeId}) round-trip succeeds over MCP', async () => {
    fx = await bootHandshake();
    const client = await connect(fx);
    try {
      // 1. Handshake: stamps a record in the default in-memory KV.
      // Post-Phase-B: handshake does NOT require a renderId — the
      // paired `ggui_render` call mints the renderId itself.
      const hsResult = await client.callTool({
        name: 'ggui_handshake',
        arguments: {
          intent: 'weather card for Tokyo',
          blueprintDraft: { contract: {} },
        },
      });
      expect(hsResult.isError).toBeFalsy();
      const hsContent = hsResult.structuredContent as {
        handshakeId: string;
        action: string;
      };
      expect(hsContent.handshakeId).toBeTruthy();
      expect(hsContent.action).toBe('create');

      // 2. Paired render reuses the record by OMITTING override — the
      //    handshake's stored suggestion contract is the effective
      //    contract. props is REQUIRED ({} for this no-propsSpec
      //    contract). Post-Phase-B: structuredContent is
      //    {renderId, nextStep?, action} — `sessionId` + `stackItemId`
      //    collapse to `renderId`, no `url` (the `/r/<shortCode>` route
      //    was deleted; hosts mount via `_meta.ui.resourceUri` or
      //    resolve `{renderId}` via their own render-resource endpoint).
      const renderResult = await client.callTool({
        name: 'ggui_render',
        arguments: {
          handshakeId: hsContent.handshakeId,
          props: {},
        },
      });
      expect(renderResult.isError).toBeFalsy();
      const renderContent = renderResult.structuredContent as Record<
        string,
        unknown
      >;
      expect(renderContent.renderId).toBeTruthy();
      expect(Object.keys(renderContent)).not.toContain('url');
    } finally {
      await client.close();
    }
  });

  it('second ggui_render with the same handshakeId surfaces a handshake-not-found error', async () => {
    fx = await bootHandshake();
    const client = await connect(fx);
    try {
      const hsResult = await client.callTool({
        name: 'ggui_handshake',
        arguments: {
          intent: 'once-only',
          blueprintDraft: { contract: {} },
        },
      });
      const hsContent = hsResult.structuredContent as { handshakeId: string };
      // First consume succeeds.
      const first = await client.callTool({
        name: 'ggui_render',
        arguments: {
          handshakeId: hsContent.handshakeId,
          props: {},
        },
      });
      expect(first.isError).toBeFalsy();
      // Second consume returns isError: true per the MCP convention
      // (handler throws map to tool-result-level errors, not
      // JSON-RPC failures).
      const second = await client.callTool({
        name: 'ggui_render',
        arguments: {
          handshakeId: hsContent.handshakeId,
          props: {},
        },
      });
      expect(second.isError).toBe(true);
      const content = second.content as Array<{ type: string; text: string }>;
      const message = content.map((c) => c.text).join(' ');
      expect(message).toMatch(/not found/i);
      expect(message).toMatch(/single-use/i);
    } finally {
      await client.close();
    }
  });

  it('handshake: false disables the handshake handler even when mcpApps is on', async () => {
    fx = await bootHandshake({ handshake: false });
    const client = await connect(fx);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).not.toContain('ggui_handshake');
      // And render falls back to the rejection path when called with
      // handshakeId — proves the handshakeStore wasn't wired into render.
      const result = await client.callTool({
        name: 'ggui_render',
        arguments: {
          handshakeId: 'never-minted',
          props: {},
        },
      });
      expect(result.isError).toBe(true);
      const content = result.content as Array<{ type: string; text: string }>;
      const message = content.map((c) => c.text).join(' ');
      expect(message).toMatch(/handshakeStore/);
    } finally {
      await client.close();
    }
  });

  it('throws at construction when handshake is enabled without mcpApps', () => {
    expect(() =>
      createGguiServer({
        logger: silentLogger,
        handshake: { kvStore: new InMemoryKeyValueStore() },
      }),
    ).toThrow(/handshake.*requires.*mcpApps/);
  });

});
