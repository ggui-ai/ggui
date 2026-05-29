/**
 * Top-level `startAgentServer` factory. Boots the second-origin
 * sandbox-proxy server (per MCP-Apps spec) AND the brand-agnostic
 * Hono app from {@link createAgentApp} on the operator-chosen port.
 *
 * One async function per-SDK samples call to stand up a full backend
 * in ~10 lines.
 */
/* eslint-disable no-console */
import { serve } from '@hono/node-server';
import {
  startSandboxProxyServer,
  type SandboxProxyServerHandle,
} from '@ggui-ai/dev-stack';
import { createAgentApp } from './app.js';
import { createInMemoryChatStore, type ChatStore } from './chat-store.js';
import type { AgentAdapter, McpServerConfig } from './types.js';

/**
 * Options for {@link startAgentServer}.
 *
 * Naming note: the public field is `mcpServers` — operator passes
 * the URL only; bearer falls back to `process.env.GGUI_MCP_BEARER`
 * (or `'dev'` for the `ggui serve --dev-allow-all` default) unless
 * the entry carries its own `bearer` override.
 */
export interface AgentServerOptions {
  readonly port: number;
  /**
   * MCP endpoints the agent's LLM is allowed to call into. Keys are
   * operator-chosen names; `ggui` is conventional for the primary
   * ggui MCP server.
   */
  readonly mcpServers: Record<string, McpServerConfig>;
  /**
   * Per-SDK adapter — implements the agent loop in terms of the
   * normalized envelope. Brand-agnostic.
   */
  readonly adapter: AgentAdapter;
  /**
   * Port for the sandbox-proxy server (default: `port + 1000`).
   * MCP-Apps spec mandates the sandbox lives on a different origin
   * from the host. Pass `0` to let the OS pick.
   */
  readonly sandboxProxyPort?: number;
  /**
   * Optional system prompt the adapter sees on every `AgentInput`.
   * Adapters MAY ignore (most SDKs prefer their own instruction
   * parameter); when omitted, the adapter chooses its own default
   * (typically `GGUI_AGENT_SYSTEM_PROMPT`). Pass `null` to disable
   * explicitly.
   */
  readonly systemPrompt?: string | null;
  /**
   * Default bearer threaded into every MCP server's auth header.
   * Falls back to `process.env.GGUI_MCP_BEARER` and then `'dev'`
   * (paired with `ggui serve --dev-allow-all`).
   */
  readonly bearer?: string;
  /**
   * Inject a custom chat store (durable backend, observability shim,
   * test fake). Defaults to in-memory.
   */
  readonly chatStore?: ChatStore;
  /**
   * Optional logger. Defaults to a `console.log` writer prefixed
   * `[agent-server]`.
   */
  readonly log?: (line: string) => void;
}

/**
 * Handle returned by {@link startAgentServer} — exposes the bound
 * port + a `close()` for graceful shutdown. Used by tests + future
 * orchestrators that want to multi-instance the server in one process.
 */
export interface AgentServerHandle {
  readonly port: number;
  readonly sandboxProxy: SandboxProxyServerHandle;
  close(): Promise<void>;
}

export async function startAgentServer(
  opts: AgentServerOptions,
): Promise<AgentServerHandle> {
  const gguiServer = opts.mcpServers.ggui;
  if (!gguiServer) {
    throw new Error(
      `startAgentServer: mcpServers must include a 'ggui' entry — got keys ${JSON.stringify(Object.keys(opts.mcpServers))}`,
    );
  }
  const bearer =
    opts.bearer ?? process.env.GGUI_MCP_BEARER ?? 'dev';
  const resolvedServers = Object.fromEntries(
    Object.entries(opts.mcpServers).map(([name, cfg]) => [
      name,
      { url: cfg.url, bearer },
    ]),
  );
  const log = opts.log ?? ((line: string): void => console.log(line));
  const chatStore = opts.chatStore ?? createInMemoryChatStore();

  const sandboxProxyPort = opts.sandboxProxyPort ?? opts.port + 1000;
  const sandboxProxy = await startSandboxProxyServer({
    port: sandboxProxyPort,
  });

  const app = createAgentApp({
    adapter: opts.adapter,
    chatStore,
    mcpServers: resolvedServers,
    systemPrompt: opts.systemPrompt ?? null,
    sandboxProxyUrl: sandboxProxy.url,
    log,
  });

  const server = serve({
    fetch: app.fetch,
    port: opts.port,
  });

  log(
    `[agent-server] chat backend ready: http://localhost:${opts.port} (adapter=${opts.adapter.name})`,
  );
  for (const [name, cfg] of Object.entries(opts.mcpServers)) {
    log(`[agent-server] mcp server '${name}': ${cfg.url}`);
  }
  log(`[agent-server] sandbox proxy: ${sandboxProxy.url}`);

  return {
    port: opts.port,
    sandboxProxy,
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await sandboxProxy.close();
    },
  };
}
