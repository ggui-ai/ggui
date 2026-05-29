/**
 * Top-level `startAgentServer` factory. Boots the second-origin
 * sandbox-proxy server (per MCP-Apps spec) AND the brand-agnostic
 * Hono app from {@link createAgentApp} on the operator-chosen port.
 *
 * Default auth: {@link createGuestTokenAuth} (token-based, no cookie
 * jar — works across browser, RN, CLI). Pass an explicit `auth`
 * option to swap in bearer-token / OAuth / JWT / platform-trust
 * adapters.
 */
/* eslint-disable no-console */
import { serve } from '@hono/node-server';
import {
  startSandboxProxyServer,
  type SandboxProxyServerHandle,
} from '@ggui-ai/dev-stack';
import { createAgentApp } from './app.js';
import { createGuestTokenAuth, type AuthAdapter } from './auth.js';
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
   * Auth adapter — resolves a {@link Principal} for every request.
   * Defaults to {@link createGuestTokenAuth} (signed bearer token,
   * client mints via POST /auth/guest) when omitted, so the zero-
   * config path natively supports anonymous guests.
   *
   * Pass `createBearerTokenAuth({tokens})` for static authenticated
   * deployments, or `createGuestTokenAuth({signingSecret})` for
   * production guest stability across restarts.
   */
  readonly auth?: AuthAdapter;
  /**
   * Port for the sandbox-proxy server (default: `port + 1000`).
   */
  readonly sandboxProxyPort?: number;
  /**
   * Optional system prompt the adapter sees on every `AgentInput`.
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
 * port + a `close()` for graceful shutdown.
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
  // Default auth is token-based guest. Honors GUEST_TOKEN_SECRET for
  // stability across restarts; otherwise emits the standard
  // "ephemeral secret" warning once.
  const auth =
    opts.auth ??
    createGuestTokenAuth(
      process.env.GUEST_TOKEN_SECRET
        ? { signingSecret: process.env.GUEST_TOKEN_SECRET }
        : {},
    );

  const sandboxProxyPort = opts.sandboxProxyPort ?? opts.port + 1000;
  // Behind a remote host (Railway, Fly, …) the browser and the servers run on
  // different machines, so the sandbox proxy must bind all interfaces and the
  // manifest must advertise its PUBLIC origin — the default localhost URL is
  // only reachable when the browser is on the same machine (local dev).
  // `SANDBOX_PROXY_PUBLIC_URL` is that public origin (set by the deploy flow);
  // when unset, behavior is unchanged (loopback bind, localhost URL).
  const sandboxProxyPublicUrl = process.env.SANDBOX_PROXY_PUBLIC_URL;
  const sandboxProxy = await startSandboxProxyServer({
    port: sandboxProxyPort,
    ...(sandboxProxyPublicUrl ? { host: '0.0.0.0' } : {}),
  });

  const app = createAgentApp({
    adapter: opts.adapter,
    auth,
    chatStore,
    mcpServers: resolvedServers,
    systemPrompt: opts.systemPrompt,
    sandboxProxyUrl: sandboxProxyPublicUrl
      ? new URL('/sandbox.html', sandboxProxyPublicUrl).href
      : sandboxProxy.url,
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
