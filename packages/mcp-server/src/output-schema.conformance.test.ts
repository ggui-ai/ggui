/**
 * The first-party server passes the kit's `output-schema` catalog (SPEC §7.9
 * "Advertised output objects", ggui#1333) — Streamable HTTP end to end: a real
 * SDK client lists tools from the shipping OSS server, and the kit grades the
 * served document exactly as an adopter's CLI run would (`--tools-list`).
 * Every tool that advertises an `outputSchema` is one row; all of them pass,
 * and at least one row exists, so the catalog is shown to look at this server
 * rather than at nothing. The live-channel harness in
 * `ggui-session-channel.conformance.test.ts` serves no `/mcp`, so it pins
 * this family as SKIPPED and names this file as where it is graded.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runOutputSchemaConformance } from '@ggui-ai/protocol-conformance';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiServer, type GguiServer } from './server.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

describe('first-party @ggui-ai/mcp-server passes the kit’s output-schema catalog (ggui#1333)', () => {
  let server: GguiServer | undefined;
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    await server?.close();
  });

  it('every tool the shipping server advertises with an outputSchema is open at every depth, and the catalog grades at least one', async () => {
    server = createGguiServer({
      logger: silentLogger,
      renderChannel: true,
      mcpApps: { wsUrl: 'ws://localhost/ws' },
      wsTokenSecret: 'test-secret-32bytes-for-hmac-1234',
      renderStore: new InMemoryGguiSessionStore(),
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('server.address() did not return AddressInfo');
    client = new Client({ name: 'output-schema-conformance', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${String(addr.port)}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer dev' } },
      }),
    );
    const { tools } = await client.listTools();
    const advertising = tools.filter((t) => t.outputSchema !== undefined).map((t) => t.name);
    expect(advertising.length).toBeGreaterThan(0);

    const graded = runOutputSchemaConformance({ tools });
    expect(graded.failed.map((f) => `${f.name}: ${f.violations.join(', ')}`)).toEqual([]);
    expect([...graded.passed].sort()).toEqual([...advertising].sort());
  });
});
