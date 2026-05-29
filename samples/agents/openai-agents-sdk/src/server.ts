/**
 * OpenAI Agents SDK sample backend — `@ggui-ai/agent-server` wired
 * to {@link createOpenAiAgentAdapter}.
 *
 * All HTTP / SSE / MCP routing / auth / chat ownership / tool-result
 * resource inlining / directive synthesis lives in the library;
 * this file is the thin per-SDK glue.
 */
import {
  startAgentServer,
  type AgentServerHandle,
  type McpServerConfig,
} from '@ggui-ai/agent-server';
import { createOpenAiAgentAdapter } from './agent.js';

export interface ServerOptions {
  readonly port: number;
  readonly mcpServers: Record<string, McpServerConfig>;
  readonly model?: string;
  readonly systemPrompt?: string | null;
  readonly sandboxProxyPort?: number;
}

export async function startServer(
  opts: ServerOptions,
): Promise<AgentServerHandle> {
  return startAgentServer({
    port: opts.port,
    mcpServers: opts.mcpServers,
    adapter: createOpenAiAgentAdapter(
      opts.model !== undefined ? { model: opts.model } : {},
    ),
    ...(opts.sandboxProxyPort !== undefined
      ? { sandboxProxyPort: opts.sandboxProxyPort }
      : {}),
    ...(opts.systemPrompt !== undefined
      ? { systemPrompt: opts.systemPrompt }
      : {}),
  });
}
