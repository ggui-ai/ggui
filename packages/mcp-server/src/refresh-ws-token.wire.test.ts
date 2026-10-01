/**
 * ggui#1510 — N−1 receipt for the refresh tool's ADVERTISED output schema.
 * The output is closed, so a client validates every answer against the schema
 * it cached at `listTools`. The fixture is the previous release's served
 * schema (tag 14, `b68b964a7`). The served schema MUST be exactly that schema
 * with one enum member deleted, `REFRESH_WINDOW_CLOSED`, which no server has
 * sent since ggui#1496 part B: compared byte for byte, so any other change
 * fails here, and the served `code` set is a strict subset of the cached one,
 * so a client holding the previous release's schema accepts every answer.
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

interface CodeProp {
  readonly type: string;
  readonly enum: readonly string[];
}
interface RefreshOutputSchema {
  readonly properties: { readonly code: CodeProp } & Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

describe('ggui_runtime_refresh_ws_token — the advertised output schema against the previous release (ggui#1510)', () => {
  it('advertises the previous release\'s schema without REFRESH_WINDOW_CLOSED, byte for byte', async () => {
    const previous = (JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) as { outputSchema: RefreshOutputSchema }).outputSchema;
    // Control: the previous release really declares the member this release drops.
    expect(previous.properties.code.enum).toContain('REFRESH_WINDOW_CLOSED');
    const expected: RefreshOutputSchema = {
      ...previous,
      properties: {
        ...previous.properties,
        code: { ...previous.properties.code, enum: previous.properties.code.enum.filter((c) => c !== 'REFRESH_WINDOW_CLOSED') },
      },
    };
    const ctx: HandlerContext = { appId: 'app-1', requestId: 'r-1' };
    const handler = createGguiRefreshWsTokenHandler({
      renderStore: new InMemoryGguiSessionStore(),
      verify: () => ({ ok: false }),
      mint: () => ({ token: 't', expiresAt: '2026-01-01T00:00:00.000Z' }),
    });
    const server = buildMcpServer({ name: 'test', version: '0' }, [handler], () => ctx, silentLogger);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'refresh-schema-wire-test', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      const tool = tools.find((t) => t.name === 'ggui_runtime_refresh_ws_token');
      expect(tool, 'the tool is listed').toBeDefined();
      expect(tool?.outputSchema).toEqual(expected);
      expect(JSON.stringify(tool?.outputSchema)).toBe(JSON.stringify(expected));
      // N−1: every code this release can answer is one the previous release's schema names.
      for (const code of expected.properties.code.enum) expect(previous.properties.code.enum).toContain(code);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
