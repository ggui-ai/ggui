/**
 * ggui#1861 — extra headers per MCP server (`McpServerConfig.headers`). A
 * declared header reaches every request the library makes to that server,
 * the library's own headers cannot be displaced in any letter case, and the
 * env reader the samples share refuses a malformed value by name.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAgentCatalog,
  callMcpInitialize,
  callMcpResourcesRead,
  callMcpToolsCall,
  callMcpToolsList,
  listModelVisibleTools,
} from './mcp-client.js';
import { checkMcpHeaders, parseMcpHeadersEnv } from './mcp-headers.js';
import { startAgentServer } from './server.js';
import type { AgentAdapter, NormalizedMessage, ResolvedMcpServer } from './types.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

const SERVER: ResolvedMcpServer = { url: 'http://mcp.test/mcp', bearer: 'b-123', headers: { 'X-Request-Source': 'docs', 'User-Agent': 'example/1' } };

/** A fetch that answers every JSON-RPC method and records each request's headers. */
function recordingFetch(): { fetch: (url: string, init: RequestInit) => Promise<Response>; seen: Array<{ method: string; headers: Record<string, string> }> } {
  const seen: Array<{ method: string; headers: Record<string, string> }> = [];
  const fetchFn = async (_url: string, init: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as { id: number; method: string };
    seen.push({ method: body.method, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    const result =
      body.method === 'initialize'
        ? { serverInfo: { name: 'x', version: '1' } }
        : body.method === 'tools/list'
          ? { tools: [{ name: 't', inputSchema: { type: 'object' } }] }
          : body.method === 'resources/read'
            ? { contents: [{ uri: 'ui://x', text: 'ok' }] }
            : { content: [] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { headers: { 'Content-Type': 'application/json' } });
  };
  return { fetch: fetchFn, seen };
}

describe('every MCP request the library makes carries the server\'s extra headers (ggui#1861)', () => {
  it('initialize, tools/list, tools/call, resources/read, the catalog and the model-visible list', async () => {
    const rec = recordingFetch();
    vi.stubGlobal('fetch', vi.fn(rec.fetch));
    await callMcpInitialize(SERVER);
    await callMcpToolsList(SERVER);
    await callMcpToolsCall({ ...SERVER, name: 't', arguments: {} });
    await callMcpResourcesRead({ ...SERVER, uri: 'ui://x' });
    await buildAgentCatalog({ s: SERVER });
    await listModelVisibleTools(SERVER);
    expect(rec.seen.map((r) => r.method)).toEqual(['initialize', 'tools/list', 'tools/call', 'resources/read', 'initialize', 'tools/list', 'tools/list']);
    for (const { method, headers } of rec.seen) {
      expect(headers['x-request-source'], method).toBe('docs');
      expect(headers['user-agent'], method).toBe('example/1');
      expect(headers.authorization, method).toBe('Bearer b-123');
      expect(headers['content-type'], method).toBe('application/json');
      expect(headers.accept, method).toBe('application/json, text/event-stream');
    }
  });

  it('a server with no extra headers sends exactly the library\'s three', async () => {
    const rec = recordingFetch();
    vi.stubGlobal('fetch', vi.fn(rec.fetch));
    await callMcpToolsList({ url: SERVER.url, bearer: 'b' });
    expect(Object.keys(rec.seen[0]!.headers).sort()).toEqual(['accept', 'authorization', 'content-type']);
  });
});

describe('checkMcpHeaders: the library\'s own headers cannot be set by an operator (ggui#1861)', () => {
  it.each(['Authorization', 'authorization', 'AUTHORIZATION', 'Content-Type', 'accept', 'Mcp-Session-Id', 'mcp-protocol-version'])('refuses %s', (name) => {
    expect(() => checkMcpHeaders('ggui', { [name]: 'x' })).toThrow(`mcpServers.ggui.headers["${name}"]`);
  });

  it('refuses a value that is not a string', () => {
    expect(() => checkMcpHeaders('ggui', { 'X-Count': 3 })).toThrow('must be a string, got number');
  });

  it('accepts any other header', () => {
    expect(() => checkMcpHeaders('ggui', { 'X-Request-Source': 'docs', 'User-Agent': 'example/1', traceparent: '00-abc' })).not.toThrow();
  });

  it('startAgentServer refuses a server with a reserved extra header before it listens', async () => {
    const adapter: AgentAdapter = {
      name: 'test',
      async *run(): AsyncIterable<NormalizedMessage> {},
    };
    await expect(
      startAgentServer({ port: 0, adapter, mcpServers: { ggui: { url: SERVER.url, headers: { authorization: 'Bearer other' } } } }),
    ).rejects.toThrow('mcpServers.ggui.headers["authorization"]');
  });
});

describe('parseMcpHeadersEnv: a JSON object of strings, or a startup error naming the variable (ggui#1861)', () => {
  it('reads an object', () => {
    expect(parseMcpHeadersEnv('GGUI_MCP_HEADERS', '{"X-Request-Source":"docs","User-Agent":"example/1"}')).toEqual({ 'X-Request-Source': 'docs', 'User-Agent': 'example/1' });
  });

  it('unset or blank is no headers', () => {
    expect(parseMcpHeadersEnv('GGUI_MCP_HEADERS', undefined)).toBeUndefined();
    expect(parseMcpHeadersEnv('GGUI_MCP_HEADERS', '  ')).toBeUndefined();
  });

  it.each([
    ['not JSON', '{X-Request-Source: docs}', 'GGUI_TODO_MCP_HEADERS must be a JSON object'],
    ['an array', '["X-Request-Source"]', 'got an array'],
    ['null', 'null', 'got null'],
    ['a string', '"X-Request-Source"', 'got string'],
    ['a non-string value', '{"X-Count":3}', 'GGUI_TODO_MCP_HEADERS["X-Count"] must be a string, got number'],
  ])('refuses %s', (_label, raw, message) => {
    expect(() => parseMcpHeadersEnv('GGUI_TODO_MCP_HEADERS', raw)).toThrow(message);
  });
});
