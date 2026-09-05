/**
 * Route-level reject-federated gate (Federation B1, Task 5).
 *
 * The `/control` plane — operator management AND design-time spec —
 * MUST reject externally-federated end-user identities: those minted by
 * the OIDC verify adapter, carrying `source: 'oidc'`. Audience
 * filtering only shapes `tools/list`; it does NOT stop a direct
 * `tools/call`, so this is a route-level authorization gate that runs
 * before MCP dispatch.
 *
 * Agents authenticate with `source: 'apikey'` / `'dev'` and MUST still
 * reach the data plane (`/mcp`) and the control plane's design-time
 * half unaffected.
 *
 * Mirrors the package's existing route-test harness in `server.test.ts`:
 * boot `createGguiServer` on an ephemeral port, then drive the real
 * HTTP surface with `fetch` (raw JSON-RPC for the rejection status) and
 * the MCP SDK `StreamableHTTPClientTransport` (for the accepted path).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server as HttpServer } from 'node:http';
import { InMemoryAuthAdapter } from '@ggui-ai/mcp-server-core/in-memory';
import type { AuthResult, CredentialScope } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '@ggui-ai/mcp-server-handlers';
import type { Logger } from './logger.js';
import { createGguiServer, type GguiServer } from './server.js';

interface BootedFixture {
  server: GguiServer;
  httpServer: HttpServer;
  url: string;
}

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

// A federated end-user identity — the shape the OIDC verify adapter
// mints (`source: 'oidc'`, `kind: 'user'`).
const FEDERATED_TOKEN = 'ftok';
const federatedResult: AuthResult = {
  identity: { kind: 'user', userId: 'guuey:g_x', appId: 'a', roles: [] },
  source: 'oidc',
};

// An agent identity — the shape an API-key adapter mints
// (`source: 'apikey'`). MUST stay unaffected by the gate.
const AGENT_TOKEN = 'atok';
const agentResult: AuthResult = {
  identity: { kind: 'builder' },
  source: 'apikey',
};

function federatedAndAgentAuth(): InMemoryAuthAdapter {
  return new InMemoryAuthAdapter({
    seedTokens: [
      { token: FEDERATED_TOKEN, result: federatedResult },
      { token: AGENT_TOKEN, result: agentResult },
    ],
  });
}

describe('mcp-endpoint-routes — reject-federated gate (/control)', () => {
  let fx: BootedFixture;

  afterEach(async () => {
    await fx.server.close();
  });

  it('a source=oidc identity gets 403 at /control', async () => {
    fx = await boot({ auth: federatedAndAgentAuth() });
    const res = await fetch(`${fx.url}/control`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${FEDERATED_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    });
    expect(res.status).toBe(403);
    // #836: a first-party server never answers -32000 (the SDK client's own
    // ConnectionClosed number); an authorization refusal is UNAUTHORIZED.
    const body = (await res.json()) as { error: { code: number; message: string } };
    expect(body.error).toEqual({
      code: -32007,
      message: 'federated identities are not permitted on this route',
    });
  });

  it('a source=oidc identity still works at /mcp', async () => {
    fx = await boot({ auth: federatedAndAgentAuth() });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${fx.url}/mcp`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${FEDERATED_TOKEN}` },
        },
      },
    );
    const client = new Client(
      { name: 'test-client', version: '0' },
      { capabilities: {} },
    );
    // Connecting completes the initialize handshake — reaching it means
    // the federated identity was NOT rejected at /mcp.
    await client.connect(transport);
    await client.close();
    expect(true).toBe(true);
  });

  it('an agent (source=apikey) identity is NOT rejected at /control', async () => {
    fx = await boot({ auth: federatedAndAgentAuth() });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${fx.url}/control`),
      {
        requestInit: {
          headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
        },
      },
    );
    const client = new Client(
      { name: 'test-client', version: '0' },
      { capabilities: {} },
    );
    // The control plane exposes design-time spec tools to agents; the
    // gate only rejects federated end-users, so an apikey caller must
    // complete the handshake (and see the protocol-tagged tools).
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('ggui_protocol_validate_blueprint');
    } finally {
      await client.close();
    }
  });

  // The control plane is anonymous-CAPABLE so design-time tools answer
  // bearer-less. The federated gate must still fire on that path —
  // otherwise an OIDC caller could reach it by simply not presenting
  // its token, which the anonymous fallback would happily accept.
  it('the design-time half answers with NO bearer at all', async () => {
    fx = await boot({ auth: federatedAndAgentAuth() });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${fx.url}/control`),
    );
    const client = new Client(
      { name: 'test-client', version: '0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain('ggui_protocol_validate_blueprint');
    } finally {
      await client.close();
    }
  });
});

/**
 * Credential scope threading (#498).
 *
 * `Identity` says WHO the caller is; `AuthResult.credentialScope` says
 * what the credential ON THIS REQUEST may act on. The two are
 * independent — one account can hold both an account-wide credential
 * and one bound to a single app, and the resolved userId is identical
 * for both — so a handler deciding whether to grant account-wide
 * authority can only read the scope. That makes the route's threading
 * of the field load-bearing, and these cases prove it over the real
 * HTTP surface rather than by inspecting the construction site.
 */
const SCOPE_ECHO_TOOL = 'scope_echo';

/** Echoes back what the route actually put on the handler context. */
function scopeEchoHandler(): SharedHandler<
  Record<string, never>,
  { scope: z.ZodString },
  { scope: string }
> {
  return {
    name: SCOPE_ECHO_TOOL,
    description: 'Echoes the credential scope the route threaded onto ctx.',
    inputSchema: {},
    outputSchema: { scope: z.string() },
    async handler(
      _input: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<{ scope: string }> {
      return { scope: JSON.stringify(ctx.credentialScope ?? null) };
    },
  };
}

async function echoScopeOverTheWire(
  scope: CredentialScope | undefined,
): Promise<{ fx: BootedFixture; echoed: unknown }> {
  const token = 'scoped-tok';
  const result: AuthResult = {
    identity: { kind: 'user', userId: 'u-1', roles: [] },
    source: 'apikey',
    ...(scope !== undefined ? { credentialScope: scope } : {}),
  };
  const fx = await boot({
    auth: new InMemoryAuthAdapter({ seedTokens: [{ token, result }] }),
    handlers: [scopeEchoHandler()],
  });
  const transport = new StreamableHTTPClientTransport(new URL(`${fx.url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client(
    { name: 'test-client', version: '0' },
    { capabilities: {} },
  );
  await client.connect(transport);
  try {
    const res = await client.callTool({ name: SCOPE_ECHO_TOOL, arguments: {} });
    const structured = res.structuredContent as { scope?: string } | undefined;
    return { fx, echoed: JSON.parse(structured?.scope ?? 'null') };
  } finally {
    await client.close();
  }
}

describe('mcp-endpoint-routes — credential scope threading (#498)', () => {
  let fx: BootedFixture;

  afterEach(async () => {
    await fx.server.close();
  });

  it('an account-scoped credential arrives on ctx.credentialScope', async () => {
    const run = await echoScopeOverTheWire({ kind: 'account' });
    fx = run.fx;
    expect(run.echoed).toEqual({ kind: 'account' });
  });

  it('an app-bound credential arrives with the app it is bound to', async () => {
    const run = await echoScopeOverTheWire({ kind: 'app', appId: 'app_1' });
    fx = run.fx;
    expect(run.echoed).toEqual({ kind: 'app', appId: 'app_1' });
  });

  it('an adapter that states no scope leaves the field absent — never a fabricated default', async () => {
    const run = await echoScopeOverTheWire(undefined);
    fx = run.fx;
    expect(run.echoed).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Per-app authorization refusals carry the deployment's JSON-RPC `data`
// (ggui#825). The per-app `authorize` hook refuses by throwing; the route
// answers a JSON-RPC error over HTTP. A deployment's `errorMapper` may
// attach JSON-RPC 2.0 `data` (a structured reason the client can read
// without parsing prose) to that refusal — bounded to 401 / 403. Anything
// else the mapper answers is ignored, logged, and the default-deny 403
// stands byte-identical to a deployment with no mapper at all.
// ---------------------------------------------------------------------------

class AppRetiredError extends Error {
  constructor() {
    super('app retired');
    this.name = 'AppRetiredError';
  }
}

function capturingLogger(): {
  logger: Logger;
  warns: Array<{ event: string; fields: Record<string, unknown> | undefined }>;
} {
  const warns: Array<{ event: string; fields: Record<string, unknown> | undefined }> = [];
  const logger: Logger = {
    info: () => undefined,
    warn: (event, fields) => {
      warns.push({ event, fields });
    },
    error: () => undefined,
    debug: () => undefined,
    child: () => logger,
  };
  return { logger, warns };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'route-test', version: '0' },
  },
};

async function initializeAgainst(url: string, appId: string): Promise<{ status: number; body: { error?: Record<string, unknown> } }> {
  const res = await fetch(`${url}/apps/${appId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${AGENT_TOKEN}`,
    },
    body: JSON.stringify(INITIALIZE),
  });
  // A refusal is a JSON body; an accepted initialize streams SSE — only
  // parse what the server declared as JSON.
  const text = await res.text();
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  return { status: res.status, body: isJson ? (JSON.parse(text) as { error?: Record<string, unknown> }) : {} };
}

const perApp = {
  paramName: 'appId',
  paramPattern: '[a-z0-9]{2,12}',
  pathPrefix: '/apps',
  authorize: async (urlAppId: string): Promise<void> => {
    if (urlAppId === 'gone') throw new AppRetiredError();
  },
};

describe('mcp-endpoint-routes — per-app authorization refusals carry JSON-RPC data (#825)', () => {
  let fx: BootedFixture;

  afterEach(async () => {
    await fx.server.close();
  });

  it("a deployment's error mapper may attach JSON-RPC `data` to an authorization refusal — the body carries it verbatim, status as mapped", async () => {
    fx = await boot({
      auth: federatedAndAgentAuth(),
      perAppRouting: perApp,
      errorMapper: (err) =>
        err instanceof AppRetiredError
          ? {
              status: 403,
              code: -32003,
              message: 'this app is no longer served',
              data: { reason: { code: 'app_retired', retry: 'never' }, ids: [1, 'a', null] },
            }
          : undefined,
    });
    const { status, body } = await initializeAgainst(fx.url, 'gone');
    expect(status).toBe(403);
    expect(body.error).toEqual({
      code: -32003,
      message: 'this app is no longer served',
      data: { reason: { code: 'app_retired', retry: 'never' }, ids: [1, 'a', null] },
    });
  });

  // ggui#850 — the per-app endpoint is a POST-only Streamable-HTTP mount
  // like every other mount here; a client's optional GET-SSE listener
  // (Google ADK opens one every turn) must read the transport's 405 with
  // `Allow: POST`, not Express's text/html 404 — a 404 says "no such
  // resource" and the client logs it as a failure on every turn. An appId
  // outside the pattern still 404s (absent resource) — that arm is the
  // `app.param` gate, and it runs for GET/DELETE only once they are mounted.
  it('GET and DELETE on a per-app endpoint answer the transport 405 with `Allow: POST` (never Express\'s 404); an appId outside the pattern stays a JSON 404 (#850)', async () => {
    fx = await boot({ auth: federatedAndAgentAuth(), perAppRouting: perApp });
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await fetch(`${fx.url}/apps/beitvdgu`, {
        method,
        headers: { accept: 'application/json, text/event-stream' },
      });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow'), method).toBe('POST');
      const body = (await res.json()) as { error?: { message?: string } };
      expect(body.error?.message, method).toBe('Method not allowed (stateless server).');
    }
    const absent = await fetch(`${fx.url}/apps/NOPE`, { method: 'GET' });
    expect(absent.status).toBe(404);
    expect(await absent.json()).toEqual({ error: 'not_found' });
  });

  it('no error mapper → the default-deny 403 Forbidden, no `data` key at all', async () => {
    fx = await boot({ auth: federatedAndAgentAuth(), perAppRouting: perApp });
    const { status, body } = await initializeAgainst(fx.url, 'gone');
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: -32007, message: 'Unauthorized' });
  });

  it('a mapper that declines (returns undefined) → byte-identical to no mapper', async () => {
    fx = await boot({ auth: federatedAndAgentAuth(), perAppRouting: perApp, errorMapper: () => undefined });
    const { status, body } = await initializeAgainst(fx.url, 'gone');
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: -32007, message: 'Unauthorized' });
  });

  it('a refusal is a 401 or a 403 — a mapper answering any other status is ignored, the default-deny 403 stands, and the deviation is logged', async () => {
    const { logger, warns } = capturingLogger();
    fx = await boot({
      auth: federatedAndAgentAuth(),
      logger,
      perAppRouting: perApp,
      errorMapper: () => ({ status: 200, code: 0, message: 'welcome', data: { ok: true } }),
    });
    const { status, body } = await initializeAgainst(fx.url, 'gone');
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: -32007, message: 'Unauthorized' });
    const deviation = warns.find((w) => w.event === 'per_app_authorize_mapper_out_of_bounds');
    expect(deviation, 'the out-of-bounds mapping must be observable on the route logger').toBeDefined();
    expect(deviation?.fields).toMatchObject({ status: 200 });
  });

  it('a mapper may answer 401 (the other refusal status) with its own code/message/data', async () => {
    fx = await boot({
      auth: federatedAndAgentAuth(),
      perAppRouting: perApp,
      errorMapper: () => ({ status: 401, code: -32007, message: 'sign in again', data: 'reauth' }),
    });
    const { status, body } = await initializeAgainst(fx.url, 'gone');
    expect(status).toBe(401);
    expect(body.error).toEqual({ code: -32007, message: 'sign in again', data: 'reauth' });
  });

  it('a mapper that throws is logged and the default-deny 403 stands', async () => {
    const { logger, warns } = capturingLogger();
    fx = await boot({
      auth: federatedAndAgentAuth(),
      logger,
      perAppRouting: perApp,
      errorMapper: () => {
        throw new Error('mapper exploded');
      },
    });
    const { status, body } = await initializeAgainst(fx.url, 'gone');
    expect(status).toBe(403);
    expect(body.error).toEqual({ code: -32007, message: 'Unauthorized' });
    expect(warns.some((w) => w.event === 'error_mapper_failed')).toBe(true);
  });

  it('an authorized app is unaffected — the mapper is never consulted on the allow path', async () => {
    let consulted = 0;
    fx = await boot({
      auth: federatedAndAgentAuth(),
      perAppRouting: perApp,
      errorMapper: () => {
        consulted += 1;
        return undefined;
      },
    });
    const { status } = await initializeAgainst(fx.url, 'fine');
    expect(status).toBe(200);
    expect(consulted).toBe(0);
  });
});
