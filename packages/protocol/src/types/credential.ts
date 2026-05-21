/**
 * Credential injection — cross-process wire protocol between the
 * open @ggui-ai/server auth relay (which writes placeholders) and
 * the closed cloud mcp-proxy service (which resolves them).
 *
 * Shared between:
 *   - packages/server/src/mcp-auth-middleware.ts (writes placeholders)
 *   - cloud/amplify/functions/rest-api/mcp-proxy/handler.ts (resolves placeholders)
 *   - cloud/services/mcp-proxy/src/* (resolves placeholders)
 *
 * Hosted-overlay shapes for the `auth` block inside per-app
 * config files are a hosting concept and not a portable wire
 * protocol. What remains here is the runtime placeholder /
 * injection-mode protocol, which is legitimately cross-process.
 */

/** How the proxy injects a credential into the outbound request. */
export type CredentialInjection =
  | 'bearer_header'
  | 'api_key_header'
  | 'query_param'
  | 'custom_header';

/** Full injection config — resolved from app config or McpServiceConfig. */
export interface CredentialInjectionConfig {
  mode: CredentialInjection;
  /** Header name for api_key_header / custom_header. Default: 'X-API-Key'. */
  headerName?: string;
  /** Query param name for query_param. Default: 'api_key'. */
  paramName?: string;
}

/**
 * Placeholder regex — matches `<ggui:credential:{serviceId}>`.
 * The placeholder is always the raw credential slot value.
 * The proxy applies injection formatting (Bearer prefix, header name, etc.).
 */
export const CREDENTIAL_PLACEHOLDER_RE = /^<ggui:credential:([a-zA-Z0-9_-]+)>$/;

/**
 * Internal control header for placeholder pre-injection.
 * - Writer: auth relay middleware only
 * - Consumer: proxy only (reads, resolves, strips before forwarding)
 * - Never forwarded upstream
 */
export const CREDENTIAL_HEADER = 'x-ggui-credential';

/** Build a placeholder string for a given serviceId. */
export function credentialPlaceholder(serviceId: string): string {
  return `<ggui:credential:${serviceId}>`;
}
