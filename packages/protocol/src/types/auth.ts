import type { JsonObject } from './data-contract';

/**
 * User authentication modes.
 *
 * - `anonymous`: no auth gate, cookie-based pseudonymous identity.
 * - `cognito`: ggui-managed Cognito identity (OAuth/OIDC handled by platform).
 * - `byo`: builder supplies their own JWT/OIDC issuer; platform validates against JWKS.
 */
export type UserAuthMode = 'anonymous' | 'cognito' | 'byo';

/**
 * Scopes requestable from ggui identity
 */
export type GguiAuthScope = 'email' | 'name' | 'picture';

/**
 * User auth config for cognito + byo modes.
 * Matches the backend UserAuthConfig schema.
 *
 * BYO has two flavors:
 *   - Render-surface HMAC-JWT shortcut: {@link authUrl} / {@link callbackSecret} /
 *     {@link tokenClaimUserId} (`your-app.example/auth/callback`, iframe UIs).
 *   - Portal BYO OAuth 2.1 flow: the `oauth*` fields below
 *     (`your-app.example/oauth/byo/callback`, native Portal).
 *   The `tokenClaim*` fields are reused across both flavors.
 */
export interface UserAuthConfig {
  // byo fields — render-surface shortcut (existing)
  authUrl?: string;             // Builder's auth endpoint
  callbackSecret?: string;      // HMAC secret for callback validation
  tokenClaimUserId?: string;    // JWT claim for user ID (default: "sub")
  tokenClaimEmail?: string;     // JWT claim for email (default: "email")
  tokenClaimName?: string;      // JWT claim for name (default: "name")
  // byo fields — Portal BYO OAuth 2.1 flow
  oauthAuthorizationUrl?: string;      // Authorization endpoint (browser redirect target)
  oauthTokenUrl?: string;              // Token endpoint (server-side POST, code exchange)
  oauthJwksUrl?: string;               // JWKS endpoint for id_token validation
  oauthIssuer?: string;                // Expected `iss` claim on id_token
  oauthClientIdPublic?: string;        // Public OAuth client id (NOT the secret)
  oauthScopes?: string[];              // Requested scopes (includes 'openid')
  oauthRedirectUriAllowlist?: string[];
  // Exact redirect URIs the builder's IdP is configured to accept.
  // Our generated redirect_uri MUST match one of these at issuance time.
  // cognito fields
  requestedScopes?: GguiAuthScope[];  // Scopes shown on consent screen
}

/**
 * Authenticated end-user identity.
 * Attached to sessions and included in events consumed by agents.
 *
 * Extends {@link JsonObject} for direct JSON serialization over WebSocket.
 */
export interface EndUserIdentity extends JsonObject {
  userId: string;               // Platform user ID or custom user ID
  email?: string;
  name?: string;
  picture?: string;
  provider: 'ggui' | 'custom';
  authenticatedAt: string;      // ISO timestamp
}

/**
 * User auth settings for an app (convenience wrapper)
 */
export interface UserAuthSettings {
  mode: UserAuthMode;
  config?: UserAuthConfig;
}
