#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `@ggui-samples/mcp-todo` — standalone streamable-HTTP MCP server
 * exposing a tiny todo-list CRUD surface for e2e scenarios.
 *
 * Boots on a single port (default 6782 — overridable via PORT env or
 * `--port N` CLI arg). One global owner ("default"); no auth, no
 * multi-tenancy. The e2e harness expects every test boot to be a
 * fresh process; `GET /admin/reset` clears state if a test needs to
 * reset mid-suite without restarting.
 *
 * Endpoints:
 *   - `POST /mcp` — JSON-RPC envelope; streamable-HTTP transport.
 *   - `GET  /admin/state` — debug helper; returns the in-memory todo
 *     list for the global owner. Useful for harness assertions that
 *     want to read backing state without an MCP round trip.
 *   - `POST /admin/reset` — clears the store. Returns `{cleared:true}`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createInMemoryTodoStore } from './store.js';
import { registerTodoTools } from './handlers.js';

const OWNER_ID = 'default';

function parsePort(): number {
  const argIdx = process.argv.indexOf('--port');
  if (argIdx >= 0 && argIdx + 1 < process.argv.length) {
    const n = Number.parseInt(process.argv[argIdx + 1]!, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const env = process.env.PORT;
  if (env !== undefined) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 6782;
}

async function main(): Promise<void> {
  const port = parsePort();
  const store = createInMemoryTodoStore();

  const server = createServer((req, res) => {
    void handleRequest(req, res, store).catch((err) => {
      console.error('[mcp-todo] request handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`internal error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  await new Promise<void>((resolve) => {
    server.listen(port, () => {
      console.log(`[mcp-todo] ready: http://localhost:${port}/mcp`);
      resolve();
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  store: ReturnType<typeof createInMemoryTodoStore>,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost`);

  // Debug helper: read current state without an MCP round trip.
  if (req.method === 'GET' && url.pathname === '/admin/state') {
    const todos = store.list(OWNER_ID);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ todos }));
    return;
  }

  // Reset state — useful for between-scenario isolation.
  if (req.method === 'POST' && url.pathname === '/admin/reset') {
    store.clear();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ cleared: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/mcp') {
    const body = await readBody(req);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid JSON body' }));
      return;
    }

    const mcp = new McpServer({
      name: '@ggui-samples/mcp-todo',
      version: '0.0.1',
      description: 'Reference todo-list MCP server for e2e scenarios.',
    });
    registerTodoTools(mcp, { store, ownerId: OWNER_ID });

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on('close', () => {
      transport.close().catch(() => undefined);
      mcp.close().catch(() => undefined);
    });

    try {
      await mcp.connect(transport);
      await transport.handleRequest(req, res, parsed);
    } catch (err) {
      console.error('[mcp-todo] mcp handle failed:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          }),
        );
      }
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('not found');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

main().catch((err) => {
  console.error('[mcp-todo] fatal:', err);
  process.exit(1);
});
