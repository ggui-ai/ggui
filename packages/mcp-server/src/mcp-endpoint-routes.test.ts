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
