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
 * Authenticated end-user identity.
 * Attached to renders and included in events consumed by agents.
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
