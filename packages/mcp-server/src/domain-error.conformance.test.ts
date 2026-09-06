/**
 * ggui#880 — the OSS server is bound to the kit's `domain-error` catalog:
 * every Plane-2 domain error a data-plane tool returns is a RESULT with
 * `isError`, its text LED by the registered slug, no `structuredContent`,
 * no `_meta`. The kit authors the six no-setup scenarios and grades the raw
 * `tools/call` result; this test is the driver — `createGguiServer` with the
 * render family on, listening on a loopback port, driven by the SDK client
 * over the real Streamable HTTP transport, nothing mocked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  isRawToolCallResult,
  runDomainErrorConformance,
  type ToolCallDriver,
} from '@ggui-ai/protocol-conformance/domain-error-conformance';
import { createGguiServer, type GguiServer } from './server.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

describe('the OSS server passes the kit\'s domain-error catalog (ggui#880)', () => {
  let server: GguiServer;
  let client: Client;

  beforeAll(async () => {
    server = createGguiServer({
      logger: silentLogger,
      renderChannel: true,
      mcpApps: { wsUrl: 'ws://localhost/ws' },
      wsTokenSecret: 'test-secret-for-domain-error-conformance',
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    const addr = httpServer.address();
    if (!addr || typeof addr === 'string') throw new Error('server.address() did not return AddressInfo');
    client = new Client({ name: 'domain-error-conformance', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`), {
        requestInit: { headers: { authorization: 'Bearer t' } },
      }),
    );
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('every catalog case passes on the raw tools/call result — isError, text, slug-leads, no structuredContent, no _meta', async () => {
    const driver: ToolCallDriver = async (scenario) => {
      const raw = await client.callTool({ name: scenario.tool, arguments: scenario.args });
      if (!isRawToolCallResult(raw)) throw new Error(`not a raw tool result: ${JSON.stringify(raw)}`);
      return raw;
    };
    const result = await runDomainErrorConformance(driver);
    expect(result.skipped).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.passed.length).toBe(6);
  });
});
