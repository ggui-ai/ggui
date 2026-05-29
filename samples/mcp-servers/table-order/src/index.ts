#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * `@ggui-samples/mcp-table-order` — one server, two persona-scoped MCP
 * endpoints over a shared SQLite-backed restaurant.
 *
 * The ROUTE picks the persona:
 *   - `POST /customer/mcp` — table-bound diner tools (browse/add/submit/…)
 *   - `POST /owner/mcp`    — restaurant-wide tools (queue/status/sales/…)
 *   - `GET  /assets/<file>`— menu photos (bundled file, else a generated
 *                            placeholder SVG so the demo renders today)
 *   - `GET  /admin/state`  — debug dump of menu/tables/orders
 *   - `POST /admin/reset`  — re-seed the demo restaurant
 *   - `POST /admin/seed`   — force a re-seed (alias of reset)
 *
 * This is a pure data backend: it never renders UI. A ggui-connected agent
 * calls `ggui_render` to draw whatever surface fits the tools it can see.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { openDb } from './db.js';
import { createStore } from './store.js';
import { createService } from './service.js';
import { seedDatabase } from './seed.js';
import { resolveAuth } from './auth.js';
import { registerCustomerTools } from './tools/customer.js';
import { registerOwnerTools } from './tools/owner.js';
import type { AuthContext, Role } from './types.js';
import type { TableOrderService } from './service.js';

const JSON_CT = { 'Content-Type': 'application/json' };
const TEXT_CT = { 'Content-Type': 'text/plain' };
const DEFAULT_PORT = 6783;

export interface StartOptions {
  readonly port?: number;
  /** SQLite file; default `:memory:` (fresh per process). */
  readonly dbFile?: string;
  /** Absolutize photo URLs against this base (else the request Host). */
  readonly publicBaseUrl?: string;
  /** Fixed "now" for deterministic seed timestamps (tests). */
  readonly seedNow?: Date;
}

/** Build a fresh per-request MCP server with the route's tool catalog. */
export function buildMcpServerForRoute(
  route: Role,
  ctx: AuthContext,
  service: TableOrderService,
  baseUrl: string,
): McpServer {
  const server = new McpServer({
    name: `@ggui-samples/mcp-table-order (${route})`,
    version: '0.0.1',
  });
  if (route === 'customer') registerCustomerTools(server, { service, ctx, baseUrl });
  else registerOwnerTools(server, { service, ctx, baseUrl });
  return server;
}

export async function startServer(
  opts: StartOptions = {},
): Promise<{ server: Server; port: number; close: () => Promise<void> }> {
  const db = openDb(opts.dbFile ?? ':memory:');
  seedDatabase(db, opts.seedNow);
  const store = createStore(db);
  const service = createService(store);
  const publicBaseUrl = opts.publicBaseUrl ?? process.env.PUBLIC_BASE_URL;
  let boundPort = opts.port ?? parsePort();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;

    if (req.method === 'GET' && pathname === '/') {
      writeJson(res, 200, {
        name: '@ggui-samples/mcp-table-order',
        endpoints: {
          customerMcp: '/customer/mcp',
          ownerMcp: '/owner/mcp',
          assets: '/assets/<file>',
          adminState: '/admin/state',
          adminReset: '/admin/reset',
          adminSeed: '/admin/seed',
        },
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/admin/state') {
      writeJson(res, 200, {
        menu: store.listMenu(),
        tables: store.listTables(),
        orders: store.listOrders(),
      });
      return;
    }
    if (req.method === 'POST' && pathname === '/admin/reset') {
      seedDatabase(db);
      writeJson(res, 200, { reset: true });
      return;
    }
    if (req.method === 'POST' && pathname === '/admin/seed') {
      seedDatabase(db);
      writeJson(res, 200, { seeded: true });
      return;
    }

    if (req.method === 'GET' && pathname.startsWith('/assets/')) {
      await serveAsset(pathname.slice('/assets/'.length), res);
      return;
    }

    if (req.method === 'POST' && (pathname === '/customer/mcp' || pathname === '/owner/mcp')) {
      const route: Role = pathname === '/customer/mcp' ? 'customer' : 'owner';
      const raw = await readBody(req);
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        writeJson(res, 400, { error: 'invalid JSON body' });
        return;
      }
      const ctx = resolveAuth(req, route);
      const baseUrl = publicBaseUrl ?? `http://${req.headers.host ?? `localhost:${boundPort}`}`;
      const mcp = buildMcpServerForRoute(route, ctx, service, baseUrl);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on('close', () => {
        transport.close().catch(() => undefined);
        mcp.close().catch(() => undefined);
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, parsed);
      } catch (err) {
        console.error('[mcp-table-order] mcp handle failed:', err);
        if (!res.headersSent) {
          writeJson(res, 500, {
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          });
        }
      }
      return;
    }

    res.writeHead(404, TEXT_CT);
    res.end('not found');
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err) => {
      console.error('[mcp-table-order] request handler error:', err);
      if (!res.headersSent) {
        res.writeHead(500, TEXT_CT);
        res.end(`internal error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(boundPort, () => resolve()));
  const addr = server.address();
  if (addr && typeof addr === 'object') boundPort = addr.port;

  return {
    server,
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
      }),
  };
}

// --- helpers ---------------------------------------------------------------

function parsePort(): number {
  const argIdx = process.argv.indexOf('--port');
  if (argIdx >= 0 && argIdx + 1 < process.argv.length) {
    const n = Number.parseInt(process.argv[argIdx + 1] ?? '', 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const env = process.env.PORT;
  if (env !== undefined) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return DEFAULT_PORT;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, JSON_CT);
  res.end(JSON.stringify(body));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

const ASSETS_DIR = fileURLToPath(new URL('../assets/', import.meta.url));

function contentTypeFor(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.svg')) return 'image/svg+xml';
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

async function serveAsset(name: string, res: ServerResponse): Promise<void> {
  // Reject anything but a flat filename (no path traversal).
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    res.writeHead(404, TEXT_CT);
    res.end('not found');
    return;
  }
  try {
    const buf = await readFile(`${ASSETS_DIR}${name}`);
    res.writeHead(200, { 'Content-Type': contentTypeFor(name), 'Cache-Control': 'public, max-age=300' });
    res.end(buf);
    return;
  } catch {
    // No bundled file yet — generate a placeholder so the menu still renders.
  }
  if (name.toLowerCase().endsWith('.svg')) {
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'public, max-age=60' });
    res.end(placeholderSvg(name));
    return;
  }
  res.writeHead(404, TEXT_CT);
  res.end('not found');
}

function humanize(file: string): string {
  return file
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

function hashHue(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}

/** A pleasant gradient placeholder card with the humanized dish name. */
function placeholderSvg(name: string): string {
  const label = humanize(name);
  const hue = hashHue(name);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420" role="img" aria-label="${label}">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(${hue} 68% 54%)"/>
    <stop offset="1" stop-color="hsl(${(hue + 38) % 360} 70% 40%)"/>
  </linearGradient></defs>
  <rect width="640" height="420" fill="url(#g)"/>
  <text x="320" y="206" font-family="system-ui, -apple-system, sans-serif" font-size="34" font-weight="700" fill="#ffffff" text-anchor="middle">${label}</text>
  <text x="320" y="246" font-family="system-ui, -apple-system, sans-serif" font-size="15" fill="rgba(255,255,255,0.82)" text-anchor="middle">sample photo</text>
</svg>`;
}

async function main(): Promise<void> {
  const { port } = await startServer();
  console.log('[mcp-table-order] ready:');
  console.log(`  customer → http://localhost:${port}/customer/mcp`);
  console.log(`  owner    → http://localhost:${port}/owner/mcp`);
  console.log(`  assets   → http://localhost:${port}/assets/<file>`);
}

const invokedDirectly = (() => {
  const entry = process.argv[1];
  return entry ? import.meta.url === pathToFileURL(entry).href : false;
})();
if (invokedDirectly) {
  main().catch((err) => {
    console.error('[mcp-table-order] fatal:', err);
    process.exit(1);
  });
}
