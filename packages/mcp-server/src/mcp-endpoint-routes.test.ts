/**
 * Route-level reject-federated gate (Federation B1, Task 5).
 *
 * `/ops` (operator-class) and `/protocol` (design-time spec) routes
 * MUST reject externally-federated end-user identities — those minted
 * by the OIDC verify adapter, carrying `source: 'oidc'`. Audience
 * filtering only shapes `tools/list`; it does NOT stop a direct
 * `tools/call`, so this is a route-level authorization gate that runs
 * before MCP dispatch.
 *
 * Agents authenticate with `source: 'apikey'` / `'dev'` and MUST still
 * reach `/mcp` (and design-time discovery on `/protocol`/`/ops` for
 * non-federated callers) unaffected.
 *
 * Mirrors the package's existing route-test harness in `server.test.ts`:
 * boot `createGguiServer` on an ephemeral port, then drive the real
 * HTTP surface with `fetch` (raw JSON-RPC for the rejection status) and
 * the MCP SDK `StreamableHTTPClientTransport` (for the accepted path).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server as HttpServer } from 'node:http';
import { InMemoryAuthAdapter } from '@ggui-ai/mcp-server-core/in-memory';
import type { AuthResult } from '@ggui-ai/mcp-server-core';
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

describe('mcp-endpoint-routes — reject-federated gate (/ops + /protocol)', () => {
  let fx: BootedFixture;

  afterEach(async () => {
    await fx.server.close();
  });

  it('a source=oidc identity gets 403 at /ops', async () => {
    fx = await boot({ auth: federatedAndAgentAuth() });
    const res = await fetch(`${fx.url}/ops`, {
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

  it('a source=oidc identity gets 403 at /protocol', async () => {
    fx = await boot({ auth: federatedAndAgentAuth() });
    const res = await fetch(`${fx.url}/protocol`, {
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

  it('an agent (source=apikey) identity is NOT rejected at /protocol', async () => {
    fx = await boot({ auth: federatedAndAgentAuth() });
    const transport = new StreamableHTTPClientTransport(
      new URL(`${fx.url}/protocol`),
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
    // The /protocol route exposes design-time spec tools to agents; the
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
});
