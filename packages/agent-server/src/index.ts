/**
 * Public entry point for `@ggui-ai/agent-server`.
 *
 * Per-SDK samples (Claude Agent SDK, OpenAI Agents SDK, Google ADK)
 * implement the {@link AgentAdapter} contract + call
 * {@link startAgentServer} — every ggui-coupled concern (HTTP,
 * SSE, MCP routing, tool-result resource inlining,
 * server-allocated chat ids, auth, chat ownership) lives in this
 * package. The prompt is forwarded to the adapter verbatim —
 * guest-gesture directives are authored upstream, in the iframe's
 * `ui/message` text.
 */
export {
  startAgentServer,
  type AgentServerOptions,
  type AgentServerHandle,
} from './server.js';

// MCP-Apps sandbox proxy — second HTTP server on a different origin
// that serves `sandbox.html` for `<AppRenderer>`'s two-iframe
// sandboxing pattern (R5). Booted by `startAgentServer`; exported so
// standalone hosts can boot it directly.
export {
  startSandboxProxyServer,
  type SandboxProxyServerOptions,
  type SandboxProxyServerHandle,
} from './sandbox-proxy.js';

export {
  createAgentApp,
  type AgentAppDeps,
  type ChatAllocatedEvent,
} from './app.js';

export {
  createInMemoryChatStore,
  mintChatId,
  type ChatRecord,
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

export {
  createGuestTokenAuth,
  createBearerTokenAuth,
  defaultAuthorizeChat,
  mintGuestId,
  principalId,
  type AuthAdapter,
  type AuthResult,
  type BearerTokenAuthOptions,
  type ChatRow,
  type GuestTokenAuthOptions,
  type Principal,
} from './auth.js';
