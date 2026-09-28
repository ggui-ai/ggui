/**
 * ggui#1496 part B — N−1 receipt for the authorized refresh: the refresh
 * tool's ADVERTISED output schema is byte-identical to the one served at
 * tag 14 (`b68b964a7`). A client that cached that schema at `listTools`
 * validates every answer an N server gives (the output is closed, so a new
 * member would be refused). The fixture was captured from the unchanged
 * handler before the change; its `code` enum still names
 * `REFRESH_WINDOW_CLOSED`, which an N−1 server sends and an N server never
 * does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiRefreshWsTokenHandler, type HandlerContext } from '@ggui-ai/mcp-server-handlers';
import { buildMcpServer } from './build-mcp.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child() {
    return silentLogger;
  },
};

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '__fixtures__/n1/refresh-ws-token.output-schema.b68b964a7.json',
);

describe('ggui_runtime_refresh_ws_token — N−1 advertised schema (ggui#1496 part B)', () => {
  it('advertises the output schema tag 14 served, byte for byte, with the new deps wired', async () => {
    const served = (JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { outputSchema: unknown }).outputSchema;
    const ctx: HandlerContext = { appId: 'app-1', requestId: 'r-1' };
    const handler = createGguiRefreshWsTokenHandler({
      renderStore: new InMemoryGguiSessionStore(),
      verify: () => ({ ok: false }),
      mint: () => ({ token: 't', expiresAt: '2026-01-01T00:00:00.000Z' }),
    });
    const server = buildMcpServer({ name: 'test', version: '0' }, [handler], () => ctx, silentLogger);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'refresh-n1-wire-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'ggui_runtime_refresh_ws_token');
      expect(tool, 'the tool is listed').toBeDefined();
      expect(tool?.outputSchema).toEqual(served);
      expect(JSON.stringify(tool?.outputSchema)).toBe(JSON.stringify(served));
    } finally {
      await client.close();
      await server.close();
    }
  });
});
