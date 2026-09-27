/**
 * ggui#1459 (declare step) — the `ggui_render` output schema a REAL MCP SDK
 * client caches at `tools/list` is CLOSED and names `effort` with the profile
 * vocabulary. Closedness is what makes a new member a two-step (declare one
 * release, emit the next): a server that sent `effort` to a host holding the
 * previous, closed schema would have every render refused. This test turns
 * "closed" from a premise into a receipt, so the next change to this output
 * reads its need for the two-step here.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { APP_GENERATION_PROFILE_EFFORTS } from '@ggui-ai/protocol';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiServer, type GguiServer } from './server.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

/** The advertised output schema, in the exact JSON the SDK projects and the client caches. */
const advertisedRenderOutput = z.object({
  additionalProperties: z.literal(false),
  properties: z.object({
    effort: z.object({ type: z.literal('string'), enum: z.array(z.string()) }),
  }),
});

describe('ggui_render over a real SDK client — the output schema is closed and declares `effort` (#1459)', () => {
  let server: GguiServer | undefined;
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    await server?.close();
  });

  it('the cached schema is closed, and `effort` lists exactly the profile vocabulary', async () => {
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
    client = new Client({ name: 'render-effort-declared', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${addr.port}/mcp`), {
        requestInit: { headers: { Authorization: 'Bearer dev' } },
      }),
    );
    const { tools } = await client.listTools();
    const render = tools.find((t) => t.name === 'ggui_render');
    const advertised = advertisedRenderOutput.parse(render?.outputSchema);
    expect([...advertised.properties.effort.enum].sort()).toEqual([...APP_GENERATION_PROFILE_EFFORTS].sort());
  });
});
