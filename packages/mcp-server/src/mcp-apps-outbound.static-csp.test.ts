/**
 * Static-shell CSP declaration — live-channel origins (#471 round 11).
 *
 * Cross-origin MCP Apps hosts (claude.ai) build the mounted frame's
 * CSP from the STATIC shell resource's `_meta.ui.csp`, not from
 * per-render resources. Deployments that set no `publicBaseUrl` (the
 * cloud pod — it feeds Origin/Host enforcement) used to declare only
 * the runtime-CDN origin, so the frame booted with
 * `connect-src assets.mcp.ggui.ai` and every network rung of the
 * failover ladder (WS, SSE, HTTP polling) was CSP-blocked — observed
 * live on claude.ai. These tests pin the `extraConnectUrls` thread:
 * the wsUrl + its http-origin flip land in `connectDomains` on BOTH
 * the bare and content-addressed shell reads.
 */
import { describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GGUI_RENDER_RESOURCE_URI } from '@ggui-ai/protocol/integrations/mcp-apps';
import { registerGguiRenderResource } from './mcp-apps-outbound.js';

const RUNTIME_URL = 'https://assets.example/iframe-runtime.abc123def456.js';
const WS_URL = 'wss://live.example/ws';

async function readCsp(uri: string, versionedUri: string, server: McpServer) {
  const client = new Client({ name: 'test-host', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  const result = await client.readResource({ uri: uri || versionedUri });
  const content = result.contents[0] as {
    _meta?: {
      ui?: { csp?: { connectDomains?: string[]; resourceDomains?: string[] } };
    };
  };
  await client.close();
  return content._meta?.ui?.csp;
}

describe('registerGguiRenderResource — extraConnectUrls in the static CSP declaration', () => {
  it('declares the wsUrl origin AND its http flip beside the runtime origin', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const versionedUri = registerGguiRenderResource(
      server,
      '<html>shell</html>',
      undefined,
      RUNTIME_URL,
      [WS_URL, 'https://live.example'],
    );
    expect(versionedUri).toMatch(
      new RegExp(`^${GGUI_RENDER_RESOURCE_URI}/rt-[0-9a-f]{12}$`),
    );
    const csp = await readCsp(versionedUri, versionedUri, server);
    expect(csp).toBeDefined();
    expect(csp?.connectDomains).toContain('https://assets.example');
    expect(csp?.connectDomains).toContain('wss://live.example');
    expect(csp?.connectDomains).toContain('https://live.example');
  });

  it('deduplicates and skips undefined/unparseable extras', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const versionedUri = registerGguiRenderResource(
      server,
      '<html>shell</html>',
      undefined,
      RUNTIME_URL,
      ['https://assets.example', undefined, 'not a url'],
    );
    const csp = await readCsp(versionedUri, versionedUri, server);
    expect(csp?.connectDomains).toEqual([
      'https://assets.example',
      'wss://assets.example',
    ]);
  });

  it('without extras the declaration is unchanged (runtime origin + ws twin only)', async () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    const versionedUri = registerGguiRenderResource(
      server,
      '<html>shell</html>',
      undefined,
      RUNTIME_URL,
    );
    const csp = await readCsp(versionedUri, versionedUri, server);
    expect(csp?.connectDomains).toEqual([
      'https://assets.example',
      'wss://assets.example',
    ]);
  });
});
