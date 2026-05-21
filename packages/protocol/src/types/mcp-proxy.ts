/**
 * Third-party MCP discovery + relay — wire shapes and public
 * constants for external MCP providers.
 *
 * Scope: constants and types that describe how OSS tooling and
 * hosted services talk to upstream MCP discovery APIs (Claude.ai
 * today; Anthropic's MCP-servers API). These are third-party
 * PROTOCOL fragments — any OSS relay that proxies Claude.ai MCP
 * servers would need the same constants and discovery-response
 * shapes.
 *
 * Hosted-overlay config types for linking these proxies into an
 * app's per-tenant config are a hosting concept and live outside
 * this open protocol package.
 *
 * What remains here:
 *
 * - Claude.ai OAuth + discovery endpoint constants (third-party
 *   public API surface).
 * - {@link DiscoveredMcpServer} — the normalised shape consumers
 *   get back from any discovery call.
 * - {@link ClaudeAiDiscoveryResponse} — raw Claude.ai discovery
 *   response wire shape.
 * - {@link CLAUDE_AI_SERVICE_ID} — credential-store service id
 *   used across the stack to name Claude.ai user credentials.
 */

// ── Claude.ai constants ─────────────────────────────────────────────

/** Claude Code's registered public OAuth client_id (PKCE, no secret). */
export const CLAUDE_AI_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Claude.ai OAuth endpoints. */
export const CLAUDE_AI_OAUTH = {
  authorizeUrl: 'https://claude.ai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  /** Manual redirect — shows auth code for user to copy. */
  manualRedirectUrl: 'https://console.anthropic.com/oauth/code/callback',
  /** Discovery endpoint for user's MCP servers. */
  discoveryUrl: 'https://api.anthropic.com/v1/mcp_servers',
  /** MCP proxy URL pattern. */
  proxyUrl: 'https://mcp-proxy.anthropic.com/v1/mcp/{server_id}',
} as const;

/** Scopes needed for MCP server access via Claude.ai. */
export const CLAUDE_AI_MCP_SCOPES = ['user:mcp_servers'] as const;

/** Beta header required for MCP servers API. */
export const CLAUDE_AI_MCP_BETA_HEADER = 'mcp-servers-2025-12-04';

// ── Discovered server shape ─────────────────────────────────────────

/** A single MCP server discovered from a proxy's discovery endpoint. */
export interface DiscoveredMcpServer {
  /** Server identifier (used in proxy URL template). */
  id: string;
  /** Human-readable name (e.g. "Google Calendar", "Gmail"). */
  displayName: string;
  /** Direct server URL (for reference — calls go through the proxy). */
  url: string;
}

/** Discovery API response shape (Claude.ai format). */
export interface ClaudeAiDiscoveryResponse {
  data: Array<{
    type: 'mcp_server';
    id: string;
    display_name: string;
    url: string;
    created_at: string;
  }>;
  has_more: boolean;
  next_page: string | null;
}

/** ServiceId used for Claude.ai platform credentials in UserCredential. */
export const CLAUDE_AI_SERVICE_ID = 'claude_ai_platform';
