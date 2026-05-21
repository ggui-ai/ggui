// packages/ui-gen/src/adapters/claude/tool-bridge.ts
//
// Bridges ToolDefinition[] → in-process MCP server for Claude Agent SDK.
//
// The Claude Agent SDK doesn't support direct function-tool definitions.
// All custom tools must go through MCP servers. This bridge creates an
// in-process MCP server from our generic ToolDefinition[] using the SDK's
// built-in tool() + createSdkMcpServer() helpers.
//
// Tool naming convention: mcp__{serverName}__{toolName}
// e.g., mcp__ggui__compile_component

import type { ToolDefinition } from '../types';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { JsonObject } from '@ggui-ai/protocol';

/** Name used for the in-process MCP server. */
export const MCP_SERVER_NAME = 'ggui';

/**
 * Create an in-process MCP server from ToolDefinition[] using
 * the Claude Agent SDK's tool() + createSdkMcpServer() helpers.
 *
 * Returns the MCP server instance and the list of allowedTools names
 * (in mcp__{server}__{tool} format).
 */
export async function createToolMcpServer(
  tools: ToolDefinition[],
): Promise<{
  server: McpSdkServerConfigWithInstance;
  allowedToolNames: string[];
}> {
  const { tool, createSdkMcpServer } = await import('@anthropic-ai/claude-agent-sdk');

  const mcpTools = tools.map((def) => {
    // Extract Zod shape from the input schema
    const shape = def.inputSchema.shape ?? {};

    return tool(
      def.name,
      def.description,
      shape,
      async (args: JsonObject) => {
        const result = await def.handler(args);
        return {
          content: result.content.map((c) => ({
            type: 'text' as const,
            text: c.text,
          })),
          ...(result.isError && { isError: true }),
        };
      },
    );
  });

  const server = createSdkMcpServer({
    name: MCP_SERVER_NAME,
    version: '1.0.0',
    tools: mcpTools,
  });

  const allowedToolNames = tools.map((t) => `mcp__${MCP_SERVER_NAME}__${t.name}`);

  return { server, allowedToolNames };
}

/**
 * Filter tool names for a specific phase (e.g., context-only or build-only).
 * Takes the original tool names (without MCP prefix) and returns
 * MCP-formatted names.
 */
export function filterMcpToolNames(
  originalNames: string[],
): string[] {
  return originalNames.map((name) => `mcp__${MCP_SERVER_NAME}__${name}`);
}
