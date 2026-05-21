/**
 * AuthAdapter — identity resolution at the server's ingress.
 *
 * Three concerns are separated in ggui auth:
 *
 *   1. Agent → server       — handled by {@link ApiKeyProvider}
 *   2. End-user → server    — does NOT exist in OSS (single-user tier)
 *   3. Viewer → server      — handled by PairingService (see ./pairing.ts)
 *
 * This interface covers concern 2 in both tiers:
 *
 *   - **OSS (personal-only):** Every authenticated identity collapses to the
 *     single builder. `OIDCAuth` / `ApiKeyAuth` are extension seams for
 *     hardened single-user deployments, NOT multi-user modes.
 *   - **Hosted runtime:** Full workspace / membership / role model. Implementation
 *     lives in `cloud/` and wraps Cognito.
 */

/**
 * Logical identity that the server knows how to act on.
 *
 * Three discriminated kinds, each modeling a distinct caller class:
 *
 *   - `'builder'` — single-tenant OSS. Every authenticated identity
 *     collapses to this; pairing-bound viewers also resolve to `'builder'`
 *     because OSS has no end-user model.
 *   - `'user'` — end-user authenticated via OIDC / Cognito JWT. Carries
 *     real user/workspace identifiers; consumed by hosted closed-runtime
 *     first-party surfaces and by future OAuth-Connector traffic on
 *     the user-pod posture (where the caller is a Claude Desktop user
 *     or equivalent end-user, not an agent or app).
 *   - `'app'` — per-app machine caller authenticated via `ggui_sk_*` API
 *     key (or playground bypass). The caller IS an app — there is no
 *     human end-user. Used by agent-builder MCP clients hitting hosted
 *     kind=app deployments and (with the `ggui_user_*` key namespace)
 *     by the user-pod Connector path. Carries `appId` + `apiKeyHash`
 *     so downstream handlers can scope reads/writes by tenant without
 *     re-deriving from headers.
 *
 * Adding a new variant is a protocol-level change — every consumer that
 * pattern-matches on `identity.kind` must add an explicit arm or fall
 * through to a defensible default. See
 * `packages/mcp-server/src/auth.ts:defaultAppIdFromIdentity` and
 * `packages/mcp-server/src/thread-transport.ts:defaultThreadOwnerFromIdentity`
 * for the canonical pattern.
 */
export type Identity =
  | { kind: 'builder' }
  | {
      kind: 'user';
      userId: string;
      workspaceId?: string;
      /**
       * Resolved scoping app for this identity (S2, 2026-05-06). Cloud
       * deployments populate this when the auth adapter knows it — either
       * because the bearer key is per-app-scoped (`ggui_user_<appId>_<secret>`),
       * or because the URL path supplied an appId, or because a
       * supplementary lookup resolved `User.defaultAppId`. OSS deployments
       * leave it `undefined`.
       *
       * `defaultAppIdFromIdentity` reads this with priority over
       * `workspaceId` and `userId` so cloud handlers scope to the correct
       * GguiApp.appId without changing the sync seam to async.
       */
      appId?: string;
      roles: string[];
    }
  | {
      kind: 'app';
      /** GguuiApp id (or `'internal'` on playground bypass). */
      appId: string;
      /** sha256 of the bearer API key (or `'playground'` on bypass). */
      apiKeyHash: string;
    };

/**
 * Result of a successful authentication.
 */
export interface AuthResult {
  identity: Identity;
  /**
   * Where the identity was proved. Informs audit logging + debugging.
   *
   * The `'anonymous'` source is synthesized by the binding layer when
   * an `McpService` declares `anonymous: true` — the request never went
   * through {@link AuthAdapter}. `identity.kind` still collapses to one
   * of the existing variants (today: `'builder'`) so consumers that
   * pattern-match on `kind` keep working without an extra arm. Handlers
   * that need to distinguish "this request was authenticated" from
   * "this request was let through anonymously" read `source` directly.
   */
  source:
    | 'dev'
    | 'oidc'
    | 'apikey'
    | 'pairing'
    | 'cognito'
    | 'oauth'
    | 'email'
    | 'anonymous';
  /** Opaque metadata — adapter-specific (sub, iss, deviceName, etc.). */
  metadata?: Record<string, string>;
}

/**
 * Minimal request shape the adapter inspects. Framework-agnostic by design —
 * the binding layer (`@ggui-ai/mcp-server`) adapts from Node http / Fetch /
 * Hono / whatever.
 */
export interface AuthRequest {
  headers: Record<string, string | undefined>;
  /** Remote address if known — for localhost-only dev bindings. */
  remoteAddress?: string;
}

/**
 * The contract. Either method MAY return null to signal "no identity"; the
 * binding layer decides whether that's an error (reject request) or a
 * downgrade (treat as anonymous).
 */
export interface AuthAdapter {
  /**
   * Resolve identity from an opaque bearer token (typical for machine auth
   * and pairing-token-driven viewer access).
   */
  authenticate(token: string): Promise<AuthResult | null>;

  /**
   * Resolve identity from an incoming request. Used for cookie-bound sessions,
   * same-origin flows, and OIDC callbacks.
   */
  getIdentity(request: AuthRequest): Promise<AuthResult | null>;

  /**
   * Register a token → identity binding. OPTIONAL — adapters that support
   * pairing MUST implement this so pairing-minted tokens authenticate
   * subsequent `/mcp` and live-channel traffic through the same bearer path
   * as every other token. Adapters backed by an external identity provider
   * (Cognito, OIDC) that can't mint local tokens may omit this — pairing
   * is incompatible with those deployments.
   *
   * Called from a `PairingService.onTokenIssued` bridge after
   * `completePairing` mints a new token. Idempotent on repeated calls
   * for the same token (later call wins).
   */
  registerToken?(token: string, result: AuthResult): void;

  /**
   * Unregister a token. OPTIONAL — paired with {@link registerToken}.
   * Called from a `PairingService.onTokenRevoked` bridge after
   * `revokePairing`. Idempotent — unregistering an unknown token is a
   * no-op, NOT an error.
   */
  unregisterToken?(token: string): void;
}

/**
 * Type guard: adapters that implement both {@link AuthAdapter.registerToken}
 * and {@link AuthAdapter.unregisterToken}. Pairing bridges require this
 * capability; callers use this guard to fail fast at composition time
 * rather than at first token issuance.
 */
export function isTokenRegisteringAuthAdapter(
  adapter: AuthAdapter,
): adapter is AuthAdapter &
  Required<Pick<AuthAdapter, 'registerToken' | 'unregisterToken'>> {
  return (
    typeof adapter.registerToken === 'function' &&
    typeof adapter.unregisterToken === 'function'
  );
}
