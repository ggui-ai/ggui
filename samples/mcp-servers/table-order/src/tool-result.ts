/**
 * Helpers for turning service calls into MCP tool results.
 *
 * `guard` runs a (synchronous) service call and maps a typed `DomainError`
 * to an MCP error result — `{ isError: true, … }` with a stable `code` —
 * so the agent can surface a clean message. Unexpected errors propagate to
 * the SDK. Success returns `structuredContent` (the typed payload) plus a
 * JSON text block, mirroring the todo sample's shape.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DomainError, type AuthContext } from './types.js';
import { identityOut } from './output-schemas.js';

export function okResult(payload: Record<string, unknown>): CallToolResult {
  return {
    structuredContent: payload,
    content: [{ type: 'text', text: JSON.stringify(payload) }],
  };
}

export function errorResult(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }],
  };
}

export function guard(fn: () => Record<string, unknown>): CallToolResult {
  try {
    return okResult(fn());
  } catch (err) {
    if (err instanceof DomainError) return errorResult(err.code, err.message);
    throw err;
  }
}

/** `whoami` is offered on both routes — proves which persona the agent is connected as. */
export function registerWhoami(server: McpServer, ctx: AuthContext): void {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Returns the resolved session identity (role + table, if any). Handy for confirming which persona this MCP connection is acting as.',
      inputSchema: {},
      outputSchema: { identity: identityOut },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => okResult({ identity: ctx }),
  );
}
