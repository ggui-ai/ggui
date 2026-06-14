/**
 * OAuth login provider seam.
 *
 * Locks the contract every OAuth-login consumer composes against:
 *
 *   - Provider implementations (`oauth-providers/{google,github}.ts`)
 *     return one of these per configured provider.
 *   - Storage (`oauth-providers-store.ts`) serializes config records
 *     and hydrates concrete providers via the registered factory.
 *   - Routes (`oauth-login.ts`) iterate the bound providers and call
 *     `authorizeUrl` / `exchangeCode` per request.
 *   - Console UI (`AdminOAuthProviders.tsx`) lists `providerId` /
 *     `displayName` per record so the operator can paste secrets
 *     into the right slot.
 *
 * Identity model: a successful OAuth callback mints a bearer for an
 * `Identity` of `{ kind: 'user', userId: '${providerId}:${providerSubject}', roles: [] }`.
 * Email is informational only — providers MAY return it (display in
 * the operator's audit log + the user's `/settings` page), but the
 * identity is always provider-namespaced. No email-based account
 * linking — different providers ⇒ different identities, period.
 *
 * **Why no email-based linking?** A user's OAuth-provider email can
 * change (they switch jobs, providers verify slowly). Linking by
 * email would let an attacker who briefly controls an email at
 * provider X impersonate the same user's account at provider Y.
 * Provider-subject is the strongest cross-provider primary key the
 * OAuth spec gives us. Future "link account" flows are explicit.
 */

/**
 * The runtime contract every concrete OAuth provider implements.
 *
 * Stateless by design — `authorizeUrl` builds the redirect URL from
 * the caller-supplied state + PKCE challenge; `exchangeCode` swaps
 * the callback `code` for the user's `providerSubject` (and optional
 * email). All provider-specific config (client_id, client_secret,
 * scopes, endpoint URLs) is captured at construction time inside the
 * concrete impl — the routes don't need to know.
 *
 * **Implementation expectations:**
 *
 *   - `providerId` is operator-stable (`'google'`, `'github'`, ...).
 *     The route `GET /ggui/oauth-login/:providerId/start` matches
 *     this value, so changing it breaks bookmarks.
 *   - `authorizeUrl` MUST URL-encode every query parameter — the
 *     state token is HMAC-bound and may contain `+` / `=` characters.
 *   - `exchangeCode` MUST send the `code_verifier` and the same
 *     `redirect_uri` the authorize step used. PKCE `S256` is the
 *     only method we support; providers that only support `plain`
 *     are out of scope (Google, GitHub both support S256).
 *   - `exchangeCode` MUST throw on any non-2xx provider response.
 *     The route catches and 400s the callback (state mismatch and
 *     network error are both "abort the flow"; finer-grained UX is
 *     a follow-up).
 *   - `providerSubject` MUST be the provider's stable user ID
 *     (Google `sub`, GitHub `id`), NEVER the email. Anyone changing
 *     this to email opens session fixation across email rotation.
 */
export interface OAuthLoginProvider {
  /** Stable URL slug for this provider — `'google'`, `'github'`, ... */
  readonly providerId: string;
  /**
   * Human-readable label for the operator's `/admin/oauth-providers`
   * page and the end-user's `/login` button. May change per release;
   * `providerId` is the stable wire field.
   */
  readonly displayName: string;
  /**
   * Build the provider's authorize URL. Caller supplies the HMAC-bound
   * `state` token and the PKCE `codeChallenge` (S256-base64url-encoded
   * SHA-256 of the verifier). The provider implementation appends its
   * own `client_id`, `redirect_uri`, `scope`, and `code_challenge_method=S256`.
   */
  authorizeUrl(input: AuthorizeUrlInput): string;
  /**
   * Exchange the callback `code` for the user's identity. `codeVerifier`
   * is the original PKCE plaintext the route stamped during /start.
   * `redirectUri` is repeated here because some providers strict-match
   * it against the authorize call (Google does; GitHub doesn't).
   */
  exchangeCode(input: ExchangeCodeInput): Promise<OAuthExchangeResult>;
}

export interface AuthorizeUrlInput {
  readonly state: string;
  readonly codeChallenge: string;
  readonly redirectUri: string;
}

export interface ExchangeCodeInput {
  readonly code: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export interface OAuthExchangeResult {
  /**
   * Provider-stable user identifier. NEVER the email; that's a UX
   * field. Used to mint `userId = '${providerId}:${providerSubject}'`.
   */
  readonly providerSubject: string;
  /**
   * Optional display email. If present, lands in audit metadata +
   * `/settings` UI. Absent providers (or users who hide their email)
   * are still authenticated; subject alone is sufficient identity.
   */
  readonly email?: string;
  /**
   * Optional display name. Same rules as `email` — UX only, never
   * load-bearing for identity decisions.
   */
  readonly displayName?: string;
}

/**
 * Storage-layer record. The serialized form sitting in
 * `~/.ggui/oauth-providers.json`. Contains the per-provider client
 * credentials the operator pasted at `/admin/oauth-providers` (or
 * the env-override values if `GGUI_OAUTH_<PROVIDERID>_CLIENT_ID` /
 * `GGUI_OAUTH_<PROVIDERID>_CLIENT_SECRET` are set).
 *
 * Storage is responsible for: file mode 0600, atomic writes, env
 * override (env wins), and surfacing `enabled: false` records so the
 * `/admin/oauth-providers` UI can render the slot without it being
 * consumable by the routes.
 */
export interface OAuthProviderConfigRecord {
  readonly providerId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /**
   * Where the values came from. UI surfaces env-overridden providers
   * as read-only ("configured (env)"); file-backed records are
   * editable.
   */
  readonly source: 'file' | 'env';
  /**
   * Operator can disable a record without deleting it. `false` keeps
   * the slot visible in the admin UI but excludes it from `/login`
   * button rendering and route lookups.
   */
  readonly enabled: boolean;
}

// composeOAuthUserId now lives in @ggui-ai/protocol (shared with the
// OIDC verify adapter, which can't import upward from mcp-server).
export { composeOAuthUserId } from "@ggui-ai/protocol";
