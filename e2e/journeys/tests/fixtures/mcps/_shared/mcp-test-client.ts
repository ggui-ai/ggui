/**
 * In-memory MCP test-client helper.
 *
 * Purpose: lets contract tests exercise a fixture MCP server through
 * the real MCP SDK wire — tools/list, tools/call with real JSON-RPC
 * framing, structuredContent round-trip — WITHOUT spawning a
 * subprocess or binding a socket.
 *
 * Uses the SDK's own `InMemoryTransport.createLinkedPair()`:
 * `createLinkedPair()` returns two transports whose `send()` is
 * wired into the other's `onmessage`. One side connects a `Client`,
 * the other connects the server. Every message goes through the
 * wire-level encoder/decoder path, so invalid inputs still surface
 * as JSON-RPC errors exactly as they would over HTTP or stdio.
 *
 * Returned handle carries a `close()` that shuts down both sides in
 * order. Tests should call it in `afterEach` regardless of test
 * outcome — lingering transports keep vitest's process alive and
 * hide failures.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export interface ConnectedMcpTestClient {
  readonly client: Client;
  close(): Promise<void>;
}

export async function connectMcpInMemory(
  server: McpServer,
  clientInfo: { readonly name?: string; readonly version?: string } = {},
): Promise<ConnectedMcpTestClient> {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    {
      name: clientInfo.name ?? 'mcp-fixture-test-client',
      version: clientInfo.version ?? '0.0.0',
    },
    { capabilities: {} },
  );
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}
