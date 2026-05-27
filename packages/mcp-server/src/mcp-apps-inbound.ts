/**
 * MCP Apps inbound hosting — resource proxy + tools/call visibility gate.
 *
 * When the ggui server hosts a third-party MCP App iframe, the browser
 * CANNOT resolve `ui://` URIs directly (browser URL scheme set is
 * limited to http/https/etc). The server owns the only path to the
 * resource bytes:
 *
 *   browser iframe
 *        ↓  https://<ggui-server>/mcp-apps/resource?session=…&item=…
 *   ggui-server proxy route
 *        ↓  MCP resources/read  (via @modelcontextprotocol/sdk/client)
 *   source MCP server
 *        ↓  ui:// resource HTML
 *   ggui-server returns the HTML bytes to the iframe.
 *
 * Similarly, iframe-originated `tools/call` flows:
 *
 *   iframe ----postMessage---> ggui client (in parent)
 *   ggui client -----fetch----> ggui-server /mcp-apps/tools-call
 *   ggui-server enforces visibility, proxies via MCP client to source.
 *
 * Visibility enforcement lives at the proxy boundary (this file), NOT
 * in the client. Source `tools/list` is fetched + cached per connector;
 * `_meta.ui.visibility` gates which tools iframe-originated calls can
 * invoke. Cross-connector calls are rejected — the iframe for connector
 * A can NEVER call tools on connector B.
 */

import type { Express, Request, Response } from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  type ConnectorRegistry,
  type RegisteredConnector,
  type RenderStore,
} from '@ggui-ai/mcp-server-core';
import { isMcpAppsRender } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { McpAppsRender } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { Logger } from './logger.js';

/** Default mount path for the MCP Apps inbound routes. */
export const DEFAULT_MCP_APPS_INBOUND_PATH = '/mcp-apps';

export interface McpAppsInboundOptions {
  readonly connectors: ConnectorRegistry;
  readonly renderStore: RenderStore;
  readonly logger: Logger;
  /** Override for the mount path prefix. Defaults to `/mcp-apps`. */
  readonly path?: string;
}

/**
 * Shape of one entry in a cached source `tools/list`.
 *
 * Kept local — we only care about the fields that gate visibility,
 * not the full MCP tool-definition shape.
 */
interface SourceToolMeta {
  readonly name: string;
  readonly visibility: ReadonlyArray<'model' | 'app'>;
}

export interface ToolsListCacheEntry {
  readonly byName: ReadonlyMap<string, SourceToolMeta>;
  readonly fetchedAt: number;
}

/**
 * Tools-list cache keyed by connectorId. Short TTL — stale visibility
 * decisions have small but real security impact, so cache invalidation
 * is time-bounded (default 60s) with on-demand refresh.
 */
export class ToolsListCache {
  private readonly map = new Map<string, ToolsListCacheEntry>();
  constructor(private readonly ttlMs: number = 60_000) {}

  get(connectorId: string): ToolsListCacheEntry | null {
    const entry = this.map.get(connectorId);
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.map.delete(connectorId);
      return null;
    }
    return entry;
  }

  set(connectorId: string, tools: Iterable<SourceToolMeta>): ToolsListCacheEntry {
    const byName = new Map<string, SourceToolMeta>();
    for (const t of tools) byName.set(t.name, t);
    const entry: ToolsListCacheEntry = { byName, fetchedAt: Date.now() };
    this.map.set(connectorId, entry);
    return entry;
  }

  invalidate(connectorId: string): void {
    this.map.delete(connectorId);
  }
}

async function connectSourceClient(
  connector: RegisteredConnector,
): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(connector.serverUrl),
    connector.auth?.bearer
      ? { requestInit: { headers: { Authorization: `Bearer ${connector.auth.bearer}` } } }
      : {},
  );
  const client = new Client(
    { name: 'ggui-mcp-apps-proxy', version: '0.0.1' },
    { capabilities: {} },
  );
  await client.connect(transport);
  return client;
}

/**
 * Parse the `_meta.ui.visibility` off an MCP tool declaration.
 * Missing / empty defaults to `['model']` per spec convention (tools
 * without explicit visibility are model-callable).
 */
function readVisibility(toolDecl: unknown): Array<'model' | 'app'> {
  if (toolDecl === null || typeof toolDecl !== 'object') return ['model'];
  const meta = (toolDecl as { _meta?: unknown })._meta;
  if (meta === null || typeof meta !== 'object') return ['model'];
  const ui = (meta as { ui?: unknown }).ui;
  if (ui === null || typeof ui !== 'object') return ['model'];
  const v = (ui as { visibility?: unknown }).visibility;
  if (!Array.isArray(v) || v.length === 0) return ['model'];
  const out: Array<'model' | 'app'> = [];
  for (const x of v) {
    if (x === 'model' || x === 'app') out.push(x);
  }
  return out.length > 0 ? out : ['model'];
}

/**
 * Resolve `{render}` from the ggui render store to a
 * {@link McpAppsRender}. Returns null if the render is missing or is
 * not an mcpApps variant.
 *
 * Phase B: a render IS the addressable unit — no per-item lookup inside
 * a stack vessel — so the render id alone resolves the McpAppsRender
 * directly. The `itemId` parameter is preserved on the wire-facing
 * query string for callsite stability but ignored when it matches the
 * renderId (which is the only valid value post-collapse).
 */
async function resolveMcpAppsItem(
  store: RenderStore,
  renderId: string,
  _itemId: string,
): Promise<McpAppsRender | null> {
  const stored = await store.get(renderId);
  if (!stored) return null;
  if (!isMcpAppsRender(stored.render)) return null;
  return stored.render;
}

/**
 * Register the MCP Apps inbound proxy routes on an Express app.
 *
 *   GET  /mcp-apps/resource?session=<id>&item=<id>
 *     Fetches the referenced McpAppsStackItem's `source.resourceUri`
 *     via resources/read on the source MCP server. Returns the HTML
 *     with the MIME declared by the source (typically
 *     `text/html;profile=mcp-app`) and spec-canonical CSP headers.
 *
 *   POST /mcp-apps/tools-call
 *     Body: { session, item, tool, arguments? }.
 *     Resolves the stack item → connector → cached tools/list, gates
 *     on `_meta.ui.visibility` (must include 'app'), and proxies the
 *     call via MCP client. Cross-connector / unknown tool / model-
 *     only tool are all rejected.
 */
export function installMcpAppsInbound(
  app: Express,
  opts: McpAppsInboundOptions,
): ToolsListCache {
  const path = opts.path ?? DEFAULT_MCP_APPS_INBOUND_PATH;
  const cache = new ToolsListCache();

  app.get(`${path}/resource`, async (req: Request, res: Response) => {
    const renderId = typeof req.query.render === 'string' ? req.query.render : '';
    const itemId = typeof req.query.item === 'string' ? req.query.item : renderId;
    if (!renderId) {
      res.status(400).type('text/plain').send('Missing ?render');
      return;
    }
    const item = await resolveMcpAppsItem(opts.renderStore, renderId, itemId);
    if (!item) {
      res.status(404).type('text/plain').send('Render not found');
      return;
    }
    const connector = await opts.connectors.get(item.source.connectorId);
    if (!connector) {
      res.status(404).type('text/plain').send('Unknown connector');
      return;
    }

    // Dev/cache optimization: inline resourceContent bypasses source fetch.
    if (typeof item.resourceContent === 'string' && item.resourceContent.length > 0) {
      res.status(200).type('text/html;profile=mcp-app').send(item.resourceContent);
      return;
    }

    let client: Client | null = null;
    try {
      client = await connectSourceClient(connector);
      const result = await client.readResource({ uri: item.source.resourceUri });
      const first = result.contents[0];
      if (!first || !('text' in first) || typeof first.text !== 'string') {
        res.status(502).type('text/plain').send('Source returned non-text resource');
        return;
      }
      // CSP composition — use the source-declared field names verbatim;
      // a stricter ggui baseline can be layered in a later slice.
      const csp = composeCsp(item);
      if (csp) res.setHeader('Content-Security-Policy', csp);
      res.status(200).type((first.mimeType as string) ?? 'text/html;profile=mcp-app').send(first.text);
    } catch (err) {
      opts.logger.error('mcp_apps_resource_proxy_failed', {
        renderId,
        itemId,
        connectorId: item.source.connectorId,
        error: String(err),
      });
      res.status(502).type('text/plain').send('Failed to fetch source resource');
    } finally {
      if (client) await client.close().catch(() => undefined);
    }
  });

  app.post(`${path}/tools-call`, async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as {
      render?: unknown;
      item?: unknown;
      tool?: unknown;
      arguments?: unknown;
    };
    const renderId = typeof body.render === 'string' ? body.render : '';
    const itemId = typeof body.item === 'string' ? body.item : renderId;
    const toolName = typeof body.tool === 'string' ? body.tool : '';
    if (!renderId || !toolName) {
      res.status(400).json({ error: 'missing_fields' });
      return;
    }
    const item = await resolveMcpAppsItem(opts.renderStore, renderId, itemId);
    if (!item) {
      res.status(404).json({ error: 'item_not_found' });
      return;
    }
    const connector = await opts.connectors.get(item.source.connectorId);
    if (!connector) {
      res.status(404).json({ error: 'unknown_connector' });
      return;
    }

    let client: Client | null = null;
    try {
      client = await connectSourceClient(connector);
      // Cache tools/list per-connector. Visibility decisions read from
      // the cache; a cold cache fetches via tools/list on the source.
      let entry = cache.get(item.source.connectorId);
      if (!entry) {
        const list = await client.listTools();
        entry = cache.set(
          item.source.connectorId,
          list.tools.map((t) => ({
            name: t.name,
            visibility: readVisibility(t),
          })),
        );
      }
      const meta = entry.byName.get(toolName);
      if (!meta) {
        res.status(404).json({ error: 'tool_not_found' });
        return;
      }
      if (!meta.visibility.includes('app')) {
        // Model-only tool — not callable from an iframe view per
        // MCP Apps visibility semantics.
        res.status(403).json({ error: 'visibility_denied' });
        return;
      }
      // Cross-connector check: the iframe for item A.connector can
      // only call tools on A.connector. Since we resolved connector
      // from `item.source.connectorId`, any other connector would
      // require a different proxy path; this handler only serves
      // `item.source.connectorId`. No-op enforcement here; see the
      // test that exercises a forged cross-connector `tool` input
      // (the tool name won't exist in THIS connector's tools-list).
      const result = await client.callTool({
        name: toolName,
        arguments: (body.arguments as Record<string, unknown> | undefined) ?? {},
      });
      res.status(200).json(result);
    } catch (err) {
      opts.logger.error('mcp_apps_tools_call_proxy_failed', {
        renderId,
        itemId,
        connectorId: item.source.connectorId,
        toolName,
        error: String(err),
      });
      res.status(502).json({ error: 'proxy_failed' });
    } finally {
      if (client) await client.close().catch(() => undefined);
    }
  });

  return cache;
}

/**
 * Compose a Content-Security-Policy header from an MCP App's declared
 * CSP metadata. Minimal — uses spec-canonical field names verbatim.
 * Returns null when no CSP was declared (caller leaves the default
 * header in place).
 */
function composeCsp(item: McpAppsRender): string | null {
  const csp = item.csp;
  if (!csp) return null;
  const parts: string[] = [];
  if (csp.connectDomains && csp.connectDomains.length > 0) {
    parts.push(`connect-src 'self' ${csp.connectDomains.join(' ')}`);
  }
  if (csp.resourceDomains && csp.resourceDomains.length > 0) {
    parts.push(
      `default-src 'self' ${csp.resourceDomains.join(' ')}`,
      `script-src 'self' 'unsafe-inline' ${csp.resourceDomains.join(' ')}`,
      `style-src 'self' 'unsafe-inline' ${csp.resourceDomains.join(' ')}`,
    );
  }
  if (csp.frameDomains && csp.frameDomains.length > 0) {
    parts.push(`frame-src 'self' ${csp.frameDomains.join(' ')}`);
  }
  return parts.length > 0 ? parts.join('; ') : null;
}
