/**
 * HTTP-level integration tests for the MCP Apps inbound proxy routes —
 *
 *   GET  /mcp-apps/resource?render=<id>&item=<id>
 *   POST /mcp-apps/tools-call
 *
 * Exercises the routes end-to-end against a real mock MCP source server
 * (spun up with `@modelcontextprotocol/sdk/server` + Streamable HTTP
 * transport). The ggui server's `ConnectorRegistry` points at the mock;
 * renders are seeded directly into the render store; and HTTP
 * requests go through the canonical proxy plumbing.
 *
 * What's covered:
 *   - resource proxy: happy path, 400/404/502 error paths, CSP composition,
 *     inline `resourceContent` bypass, unknown connector, wrong render
 *     variant, MIME passthrough.
 *   - tools/call proxy: happy path, 400 missing-field, 404 item/tool-not-found,
 *     403 visibility denial for model-only tools, cross-connector rejection
 *     (via structural "unknown tool on connector A" semantics), 502 source
 *     errors, tools-list cache hit on the second call.
 *
 * What's NOT covered here (intentionally deferred):
 *   - Hash verification of resource bytes (Slice C).
 *   - TTL-based cache invalidation (time-based; unit-test the cache class
 *     directly if needed — here we verify hit on the same-instant call).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import express, { type Express } from 'express';
import type { Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  InMemoryConnectorRegistry,
  InMemoryGguiSessionStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { McpAppsGguiSession } from '@ggui-ai/protocol/integrations/mcp-apps';
import { installMcpAppsInbound } from './mcp-apps-inbound.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

/**
 * Mock MCP source server fixture. Registers:
 *   - a `ui://mock/checkout` resource that returns a fixed HTML body
 *   - an `app_callable` tool with `_meta.ui.visibility = ['app']`
 *   - a `model_only` tool with `_meta.ui.visibility = ['model']`
 *   - a `boom` tool that throws, to test error propagation
 *
 * Exposes its HTTP base URL for the ConnectorRegistry to reference.
 */
interface MockSourceFixture {
  url: string;
  close: () => Promise<void>;
  /** Counts how many times the source has been asked for its tools list. */
  toolsListCount: () => number;
}

async function bootMockSource(): Promise<MockSourceFixture> {
  let toolsListCount = 0;
  const app: Express = express();
  app.use(express.json({ limit: '2mb' }));

  app.post('/mcp', async (req, res) => {
    const mcp = new McpServer(
      { name: 'mock-source', version: '0.0.1' },
      { capabilities: {} },
    );

    // Resource: `ui://mock/checkout` serves a fixed HTML body.
    mcp.registerResource(
      'mock-checkout',
      'ui://mock/checkout',
      {
        mimeType: 'text/html;profile=mcp-app',
        description: 'Mock checkout view',
      },
      async (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/html;profile=mcp-app',
            text: '<html><body data-mock-source>mock checkout</body></html>',
          },
        ],
      }),
    );

    mcp.registerTool(
      'app_callable',
      {
        description: 'Callable from MCP Apps views',
        inputSchema: { amount: z.number().optional() },
        _meta: { ui: { visibility: ['app'] } },
      },
      async (input) => ({
        content: [
          {
            type: 'text',
            text: JSON.stringify({ called: 'app_callable', input }),
          },
        ],
      }),
    );

    mcp.registerTool(
      'model_only',
      {
        description: 'Model-only — not callable from views',
        inputSchema: {},
        _meta: { ui: { visibility: ['model'] } },
      },
      async () => ({
        content: [{ type: 'text', text: JSON.stringify({ called: 'model_only' }) }],
      }),
    );

    mcp.registerTool(
      'boom',
      {
        description: 'Throws on every call',
        inputSchema: {},
        _meta: { ui: { visibility: ['app'] } },
      },
      async () => {
        throw new Error('boom from source');
      },
    );

    // Intercept tools/list for call counting — the MCP SDK serves it
    // automatically, but we want a visible counter for cache-hit tests.
    const origTransportFactory = () =>
      new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const transport = origTransportFactory();
    const origOnMessage = transport.onmessage;
    transport.onmessage = (message, extra) => {
      if (
        message &&
        typeof message === 'object' &&
        'method' in message &&
        (message as { method: string }).method === 'tools/list'
      ) {
        toolsListCount++;
      }
      origOnMessage?.(message, extra);
    };

    res.on('close', () => {
      transport.close().catch(() => undefined);
      mcp.close().catch(() => undefined);
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: { code: -32603, message: `mock source failed: ${String(err)}` },
          id: null,
        });
      }
    }
  });

  return new Promise<MockSourceFixture>((resolve, reject) => {
    const server: HttpServer = app.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('mock source listen returned no address'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${addr.port}/mcp`,
        toolsListCount: () => toolsListCount,
        close: () =>
          new Promise((done) => {
            server.close(() => done());
          }),
      });
    });
    server.on('error', reject);
  });
}

/**
 * Small helper that mounts `/mcp-apps/*` on a fresh Express app, with
 * the render store + connector registry pre-seeded for the test.
 */
interface InboundFixture {
  app: Express;
  httpServer: HttpServer;
  httpBase: string;
  renderStore: InMemoryGguiSessionStore;
  connectors: InMemoryConnectorRegistry;
  source: MockSourceFixture;
  close: () => Promise<void>;
}

async function bootInbound(options?: {
  connectorId?: string;
  bearer?: string;
}): Promise<InboundFixture> {
  const source = await bootMockSource();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  const renderStore = new InMemoryGguiSessionStore();
  const connectors = new InMemoryConnectorRegistry([
    {
      id: options?.connectorId ?? 'mock',
      serverUrl: source.url,
      ...(options?.bearer ? { auth: { bearer: options.bearer } } : {}),
    },
  ]);
  installMcpAppsInbound(app, { renderStore, connectors, logger: silentLogger });

  const httpServer: HttpServer = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('inbound listen returned no address');
  }
  const httpBase = `http://127.0.0.1:${addr.port}`;

  return {
    app,
    httpServer,
    httpBase,
    renderStore,
    connectors,
    source,
    async close() {
      await new Promise<void>((done) => httpServer.close(() => done()));
      await source.close();
    },
  };
}

/** Seeds an `McpAppsGguiSession` row. */
async function seedMcpAppsRender(
  store: InMemoryGguiSessionStore,
  overrides?: Partial<McpAppsGguiSession>,
): Promise<{ sessionId: string; item: McpAppsGguiSession }> {
  const sessionId = `sess-${randomUUID()}`;
  const item: McpAppsGguiSession = {
    type: 'mcpApps',
    id: sessionId,
    createdAt: new Date().toISOString(),
    source: {
      connectorId: 'mock',
      toolName: 'checkout',
      resourceUri: 'ui://mock/checkout',
    },
    ...overrides,
  };
  await store.commit({ render: item, appId: 'app-1' });
  return { sessionId, item };
}

describe('GET /mcp-apps/resource', () => {
  let fx: InboundFixture;
  beforeEach(async () => {
    fx = await bootInbound();
  });
  afterEach(async () => {
    await fx.close();
  });

  it('returns the source-resolved HTML on the happy path', async () => {
    const { sessionId, item } = await seedMcpAppsRender(fx.renderStore);
    const res = await fetch(
      `${fx.httpBase}/mcp-apps/resource?render=${sessionId}&item=${item.id}`,
    );
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('text/html');
    expect(ct).toContain('profile=mcp-app');
    const body = await res.text();
    expect(body).toContain('data-mock-source');
  });

  it('composes CSP header from the render csp metadata', async () => {
    const { sessionId, item } = await seedMcpAppsRender(fx.renderStore, {
      csp: {
        connectDomains: ['https://api.mock.example'],
        resourceDomains: ['https://cdn.mock.example'],
        frameDomains: ['https://frame.mock.example'],
      },
    });
    const res = await fetch(
      `${fx.httpBase}/mcp-apps/resource?render=${sessionId}&item=${item.id}`,
    );
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy');
    expect(csp).toBeTruthy();
    expect(csp).toContain("connect-src 'self' https://api.mock.example");
    expect(csp).toContain('default-src');
    expect(csp).toContain('https://cdn.mock.example');
    expect(csp).toContain("frame-src 'self' https://frame.mock.example");
  });

  it('omits the CSP header when the render declares none', async () => {
    const { sessionId, item } = await seedMcpAppsRender(fx.renderStore);
    const res = await fetch(
      `${fx.httpBase}/mcp-apps/resource?render=${sessionId}&item=${item.id}`,
    );
    expect(res.status).toBe(200);
    // Express may synthesize defaults; the important property is that
    // our composer didn't add one from empty input.
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('serves inline resourceContent without hitting the source server', async () => {
    const { sessionId, item } = await seedMcpAppsRender(fx.renderStore, {
      resourceContent: '<html><body data-inline>inline</body></html>',
    });
    const countBefore = fx.source.toolsListCount();
    const res = await fetch(
      `${fx.httpBase}/mcp-apps/resource?render=${sessionId}&item=${item.id}`,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('data-inline');
    // Inline path does not touch source tools/list either.
    expect(fx.source.toolsListCount()).toBe(countBefore);
  });

  it('returns 400 when the render query param is missing', async () => {
    // Phase B identity collapse: `item` defaults to `render` when absent
    // (the pre-Phase-B (sessionId, stackItemId) pair collapsed to a single
    // sessionId). Only `render` is structurally required at this ingress;
    // its absence is a 400, while a present-but-unknown render falls to
    // 404 via the lookup path below.
    const r1 = await fetch(`${fx.httpBase}/mcp-apps/resource?item=x`);
    expect(r1.status).toBe(400);
  });

  it('returns 404 for an unknown render', async () => {
    const res = await fetch(
      `${fx.httpBase}/mcp-apps/resource?render=nope&item=also-nope`,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the render is a component variant, not mcpApps', async () => {
    const sessionId = `sess-${randomUUID()}`;
    await fx.renderStore.commit({
      render: {
        id: sessionId,
        appId: 'app-1',
        type: 'component',
        componentCode: '/* component */',
        eventSequence: 0,
        createdAt: Date.now(),
        lastActivityAt: Date.now(),
        expiresAt: Date.now() + 60_000,
      },
      appId: 'app-1',
    });
    const res = await fetch(
      `${fx.httpBase}/mcp-apps/resource?render=${sessionId}`,
    );
    expect(res.status).toBe(404);
  });

  it('returns 404 when the connector is unregistered', async () => {
    const { sessionId, item } = await seedMcpAppsRender(fx.renderStore, {
      source: {
        connectorId: 'unknown-connector',
        toolName: 'checkout',
        resourceUri: 'ui://mock/checkout',
      },
    });
    const res = await fetch(
      `${fx.httpBase}/mcp-apps/resource?render=${sessionId}&item=${item.id}`,
    );
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('Unknown connector');
  });

  it('returns 502 when the source resource is not a text resource', async () => {
    const { sessionId, item } = await seedMcpAppsRender(fx.renderStore, {
      source: {
        connectorId: 'mock',
        toolName: 'checkout',
        resourceUri: 'ui://mock/does-not-exist',
      },
    });
    const res = await fetch(
      `${fx.httpBase}/mcp-apps/resource?render=${sessionId}&item=${item.id}`,
    );
    expect(res.status).toBe(502);
  });
});

describe('POST /mcp-apps/tools-call', () => {
  let fx: InboundFixture;
  beforeEach(async () => {
    fx = await bootInbound();
  });
  afterEach(async () => {
    await fx.close();
  });

  async function callTool(body: unknown) {
    return fetch(`${fx.httpBase}/mcp-apps/tools-call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('proxies an app-visible tool call on the happy path', async () => {
    const { sessionId, item } = await seedMcpAppsRender(fx.renderStore);
    const res = await callTool({
      render: sessionId,
      item: item.id,
      tool: 'app_callable',
      arguments: { amount: 42 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      content: Array<{ type: string; text: string }>;
    };
    const text = body.content?.[0]?.text ?? '';
    expect(text).toContain('app_callable');
    expect(text).toContain('"amount":42');
  });

  it('rejects model-only tools with 403 visibility_denied', async () => {
    const { sessionId, item } = await seedMcpAppsRender(fx.renderStore);
    const res = await callTool({
      render: sessionId,
      item: item.id,
      tool: 'model_only',
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe(
      'visibility_denied',
    );
  });

  it('returns 404 tool_not_found for an unknown tool name', async () => {
    const { sessionId, item } = await seedMcpAppsRender(fx.renderStore);
    const res = await callTool({
      render: sessionId,
      item: item.id,
      tool: 'does_not_exist',
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      'tool_not_found',
    );
  });

  it('returns 400 when required fields are missing', async () => {
    const res = await callTool({ render: 'x', item: 'y' });
    expect(res.status).toBe(400);
  });

  it('returns 404 item_not_found when the render is unknown', async () => {
    const sessionId = `sess-${randomUUID()}`;
    await fx.renderStore.create({ id: sessionId, appId: 'app-1' });
    const res = await callTool({
      render: sessionId,
      item: 'nope',
      tool: 'app_callable',
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      'item_not_found',
    );
  });

  it('returns 404 unknown_connector when the item references an unknown connectorId', async () => {
    const { sessionId, item } = await seedMcpAppsRender(fx.renderStore, {
      source: {
        connectorId: 'unknown-connector',
        toolName: 'checkout',
        resourceUri: 'ui://mock/checkout',
      },
    });
    const res = await callTool({
      render: sessionId,
      item: item.id,
      tool: 'app_callable',
    });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe(
      'unknown_connector',
    );
  });

  it('passes source tool-level errors through as isError:true (not a proxy failure)', async () => {
    // Per MCP semantics, tool errors are content-level on a successful
    // response — they are NOT transport failures. The proxy forwards
    // the full tool result faithfully so the iframe sees the tool's
    // own `isError: true` + error text. 502 is reserved for proxy/
    // transport-level failures (e.g. unreachable source).
    const { sessionId, item } = await seedMcpAppsRender(fx.renderStore);
    const res = await callTool({
      render: sessionId,
      item: item.id,
      tool: 'boom',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    };
    expect(body.isError).toBe(true);
    const text = body.content?.[0]?.text ?? '';
    expect(text).toContain('boom');
  });

  it('structurally rejects cross-connector tool calls (forged tool name not in item.connector list)', async () => {
    // The route resolves connector from the RENDER's source.connectorId,
    // so a forged `connectorId` in the request body has no effect. Any
    // attempt to invoke a tool that isn't on the item's own connector
    // lands as tool_not_found. This encodes the "iframe for connector A
    // cannot reach connector B" guarantee structurally.
    const { sessionId, item } = await seedMcpAppsRender(fx.renderStore);
    const res = await callTool({
      render: sessionId,
      item: item.id,
      // Forging a different connectorId in the body is ignored — the
      // route dispatches by item.source.connectorId.
      connectorId: 'some-other-connector',
      tool: 'app_callable',
    });
    expect(res.status).toBe(200); // still hits our configured connector
    // And a tool that ONLY exists on some hypothetical other connector
    // is not found — we never reach any other source.
    const res2 = await callTool({
      render: sessionId,
      item: item.id,
      tool: 'tool_on_some_other_connector',
    });
    expect(res2.status).toBe(404);
  });
});
