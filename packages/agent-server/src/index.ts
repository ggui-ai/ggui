/**
 * Public entry point for `@ggui-ai/agent-server`.
 *
 * Per-SDK samples (Claude Agent SDK, OpenAI Agents SDK, Google ADK)
 * implement the {@link AgentAdapter} contract + call
 * {@link startAgentServer} — every ggui-coupled concern (HTTP,
 * SSE, MCP routing, tool-result resource inlining, directive
 * synthesis, server-allocated chat ids) lives in this package.
 */
export {
  startAgentServer,
  type AgentServerOptions,
  type AgentServerHandle,
} from './server.js';

export { createAgentApp, type AgentAppDeps, type ChatAllocatedEvent } from './app.js';

export {
  createInMemoryChatStore,
  mintChatId,
  type ChatStore,
} from './chat-store.js';

export type {
  AgentAdapter,
  AgentInput,
  McpServerConfig,
  NormalizedMessage,
  McpCallToolResult,
  ChatStateSnapshot,
} from './types.js';

export { synthesizeUserActionPrompt } from './user-action-prompt.js';

export {
  interceptToolResult,
  selectMcpServerForResource,
  type InterceptorMcpServers,
} from './tool-result-interceptor.js';

export {
  callMcpResourcesRead,
  callMcpToolsCall,
  parseMcpResponse,
} from './mcp-client.js';
