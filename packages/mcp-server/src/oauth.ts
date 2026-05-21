/**
 * OAuth 2.1 + PKCE + Dynamic Client Registration for the MCP server.
 *
 * Implements the auth flow MCP clients (Claude Desktop, claude.ai,
 * Goose, etc.) expect from a remote MCP server per spec 2025-06-18+.
 *
 * ## Flow
 *
 *   1. Client hits `/mcp` without auth → 401 with
 *      `WWW-Authenticate: Bearer resource_metadata="<url>"`.
 *   2. Client fetches the resource metadata
 *      (`/.well-known/oauth-protected-resource`, RFC 9728) → discovers
 *      the authorization server URL.
 *   3. Client fetches the auth server metadata
 *      (`/.well-known/oauth-authorization-server`, RFC 8414) →
 *      discovers `authorize` / `token` / `register` endpoints.
 *   4. Client POSTs to `/oauth/register` (RFC 7591 Dynamic Client
 *      Registration) → server returns a random `client_id`. PKCE-only,
 *      so no `client_secret` is issued.
 *   5. Client redirects user-agent to `/oauth/authorize?...&code_challenge=...`
 *      → server renders an HTML page asking the user to paste their
 *      `ggui_user_*` API key.
 *   6. User pastes key + submits → server validates the key against the
 *      configured {@link AuthAdapter} (same adapter that gates `/mcp`),
 *      mints an authorization code, redirects back to the client's
 *      `redirect_uri` with `?code=...`.
 *   7. Client POSTs to `/oauth/token` with `code` + `code_verifier` →
 *      server validates PKCE, returns the user's `ggui_user_*` key as
 *      the `access_token`.
 *   8. Client retries `/mcp` with `Authorization: Bearer ggui_user_*`
 *      → existing `ApiKeyAuthAdapter` accepts it. ✅
 *
 * ## Why the access token IS the API key
 *
 * The simplest possible bridge between MCP's OAuth-required client UX
 * and ggui's existing API-key auth model. No parallel token table, no
 * key→token translation in the request hot path, no token-refresh
 * dance. The "OAuth flow" becomes a one-time ceremony Claude Desktop
 * runs to capture the user's already-minted key into its own credential
 * storage. After that, every `/mcp` request is identical to a CLI call
 * with `Authorization: Bearer ggui_user_*`.
 *
 * Trade-off: the access token TTL = the API key TTL. If the user
 * revokes the key, Claude Desktop's stored token stops working at the
 * next request (intended: revocation works without OAuth-specific
 * machinery). No refresh token issued — re-auth means re-running the
 * OAuth ceremony, which is a one-paste step.
 *
 * ## Storage
 *
 * Auth codes + DCR clients live in-memory ({@link InMemoryOAuthStorage}).
 * For multi-replica deployments (e.g. `mcp.ggui.ai` with 2+ pods),
 * either:
 *   - Use nginx-ingress sticky sessions so the same pod handles both
 *     `/oauth/authorize` and `/oauth/token` (current sandbox posture).
 *   - Plug a Redis-backed {@link OAuthStorage} via the
 *     `oauth.storage` config option (production posture).
 *
 * DCR clients are short-lived in practice — Claude Desktop registers
 * once per install + caches the `client_id`. A pod restart drops all
 * registrations; clients re-register transparently on next failure.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { AuthAdapter, PairingService } from '@ggui-ai/mcp-server-core';
import { resolveIdentity, UnauthenticatedError } from './auth.js';

// =============================================================================
// Config
// =============================================================================

export interface OAuthConfig {
  /**
   * Public origin of this server (e.g. `https://mcp.ggui.ai`). Used in
   * discovery metadata, `WWW-Authenticate` headers, and OAuth redirects.
   * Should NOT have a trailing slash. When absent, the server derives
   * it from the request's `Host` header — fine for most deployments,
   * fragile when a proxy rewrites the host.
   */
  readonly issuerUrl?: string;

  /**
   * Storage seam for auth codes + DCR clients. Defaults to
   * {@link InMemoryOAuthStorage} — works for single-replica dev + any
   * deployment with sticky sessions. Replace with a Redis/DDB-backed
   * implementation for stateless multi-replica deployments.
   */
  readonly storage?: OAuthStorage;

  /**
   * External consent UI to delegate the user-facing approval step to
   * (e.g. `https://console.ggui.ai/oauth/consent`). When set,
   * `GET /oauth/authorize` returns a 302 to this URL with every OAuth
   * query param forwarded verbatim — the consent UI then constructs an
   * HTML form that POSTs back to `<issuer>/oauth/authorize` with the
   * user's chosen `api_key`.
   *
   * Trade-off: the consent UI sees every OAuth param + the user's
   * Cognito session — it MUST be operator-controlled (same trust
   * boundary as the MCP server itself). Cross-origin POST is fine
   * (form-encoded → no CORS preflight); the response is a 302 to the
   * client's `redirect_uri` which the browser follows transparently.
   *
   * Absence: `GET /oauth/authorize` falls back to the in-server
   * paste-key HTML page. Useful for OSS deployers who don't want to
   * stand up a separate consent UI; the form works but is unbranded.
   */
  readonly consentUrl?: string;

  /**
   * RFC 8707 resource indicator validator. Receives
   * the resolved `issuer` URL plus the client-supplied `resource`
   * query param value; returns `true` when `resource` names a valid
   * MCP endpoint on this deployment, `false` otherwise.
   *
   * For ggui this gates two shapes:
   *   - Universal: `${issuer}` (cloud bare root) or
   *     `${issuer}${universalMcpPath}` (OSS `/mcp`).
   *   - Per-app:   `${issuer}${perAppRouting.pathPrefix}/<appId>`
   *     where `<appId>` matches `perAppRouting.paramPattern`.
   *
   * server.ts builds this validator at boot from the deployment shape
   * (universalMcpPath + perAppRouting); the OAuth handlers stay
   * deployment-agnostic. When omitted, the resource param is accepted
   * as-is without validation — fine for OSS deployments that don't
   * advertise per-app endpoints.
   *
   * RFC 8707 §2 — auth servers SHOULD reject unknown resources with
   * `invalid_target`. We do that at /authorize time so the user sees
   * a clear error before the consent step (vs. silently issuing a
   * code that then fails at /token).
   */
  readonly validateResource?: (issuer: string, resource: string) => boolean;
}

// =============================================================================
// Storage seam
// =============================================================================

export interface AuthCodeRecord {
  readonly code: string;
  /**
   * The user's `ggui_user_*` API key — returned verbatim as the
   * `access_token` on `/oauth/token` exchange. The auth code is the
   * server-side handle that prevents the key from leaking through the
   * redirect URL (which logs / referers can capture).
   */
  readonly accessToken: string;
  /** PKCE — `S256(code_verifier)` computed at /authorize time. */
  readonly codeChallenge: string;
  /** Redirect URI the client claimed at /authorize — must match at /token. */
  readonly redirectUri: string;
  /** Client id from DCR. */
  readonly clientId: string;
  /** Unix epoch ms — codes expire after 5 minutes. */
  readonly expiresAt: number;
  /**
   * RFC 8707 resource indicator. Captured at
   * /authorize time; if the /token request includes a `resource`
   * parameter, it MUST equal this value (RFC 8707 §2.2). Absent
   * when the client didn't claim a specific resource — universal
   * scoping applies.
   *
   * Storage shape note: persisted on the auth-code row only. Tokens
   * issued by /token are opaque static keys (`ggui_user_*`); the
   * appId-from-resource binding is enforced at the auth-code →
   * token boundary, not via JWT claims. Runtime appId resolution
   * keeps reading the key shape (`UserKey.appId` from the
   * `GguiUserApiKey` row).
   */
  readonly resource?: string;
}

export interface ClientRecord {
  readonly clientId: string;
  readonly redirectUris: readonly string[];
  /** Optional human-readable label from DCR `client_name`. */
  readonly clientName?: string;
  /** Unix epoch ms — for cleanup; clients have no hard expiry. */
  readonly createdAt: number;
  /**
   * RFC 8707 resource indicator from this client's most recent
   * `/oauth/authorize` request (Q7 RESOLVED 2026-05-06). Captured
   * each time `handleAuthorizePost` consumes the params — surfaces
   * "Connected to: <App>" on the operator's Connected Apps console
   * once that surface goes live. DCR itself doesn't carry resource
   * (clients don't know their target at registration time); per-app
   * resource is a per-/authorize-request property, so we snapshot
   * the latest one onto the client record for display.
   *
   * Absent when the client never used a resource indicator (universal
   * scoping). Absent on pre-2026-05-06 records (graceful undefined
   * rather than null/empty-string) — operators see "Universal" in
   * the UI for those.
   */
  readonly lastResource?: string;
  /**
   * Unix epoch ms of the most recent `/oauth/authorize` POST that
   * referenced this client. Pairs with {@link lastResource} for
   * "last seen" UI hints. Distinct from `createdAt` (DCR registration
   * time) — a client may have registered weeks ago but only just
   * now run its first authorize.
   */
  readonly lastAuthorizeAt?: number;
}

/**
 * Storage interface for OAuth state. Two collections:
 *   - **Auth codes** (short-lived, single-use): one-time tokens
 *     returned from /authorize, exchanged at /token for an access token.
 *   - **DCR clients** (long-lived): registered via /oauth/register,
 *     identifies which client is making subsequent OAuth requests.
 *
 * `listClients` + `deleteClient` back the console's "Connected Apps"
 * management surface so operators can see who registered + revoke
 * stale entries without a server restart.
 *
 * **Revocation semantics on `deleteClient`:** removes the
 * registration only. In-flight access tokens minted under that
 * client_id are NOT invalidated here (in the current paste-key flow
 * `access_token === paired_bearer`, so cutting the bearer means
 * cutting EVERYONE). Revoking only stops future `/oauth/register`
 * re-discovery and `/oauth/token` exchanges from that client. This is
 * documented at the console route level.
 */
export interface OAuthStorage {
  putAuthCode(record: AuthCodeRecord): Promise<void>;
  /** Atomic fetch-and-delete (single-use enforcement). */
  consumeAuthCode(code: string): Promise<AuthCodeRecord | null>;
  putClient(record: ClientRecord): Promise<void>;
  getClient(clientId: string): Promise<ClientRecord | null>;
  /**
   * List every registered DCR client, sorted oldest-first by
   * `createdAt`. Operator-facing; the console's Connected Apps tab
   * paints from this. Empty array when no clients have registered
   * yet.
   */
  listClients(): Promise<readonly ClientRecord[]>;
  /**
   * Delete a single client registration by `clientId`. Idempotent —
   * deleting an unknown id resolves cleanly (no error, no state
   * change). See {@link OAuthStorage} doc for the in-flight-token
   * caveat.
   */
  deleteClient(clientId: string): Promise<void>;
}

export class InMemoryOAuthStorage implements OAuthStorage {
  private readonly codes = new Map<string, AuthCodeRecord>();
  private readonly clients = new Map<string, ClientRecord>();

  async putAuthCode(record: AuthCodeRecord): Promise<void> {
    this.codes.set(record.code, record);
    // Lazy GC — every put walks 1% of the map and prunes expired entries.
    // Keeps the map bounded without a separate sweeper.
    if (Math.random() < 0.01) {
      const now = Date.now();
      for (const [k, v] of this.codes) {
        if (v.expiresAt < now) this.codes.delete(k);
      }
    }
  }

  async consumeAuthCode(code: string): Promise<AuthCodeRecord | null> {
    const record = this.codes.get(code);
    if (!record) return null;
    this.codes.delete(code);
    if (record.expiresAt < Date.now()) return null;
    return record;
  }

  async putClient(record: ClientRecord): Promise<void> {
    this.clients.set(record.clientId, record);
  }

  async getClient(clientId: string): Promise<ClientRecord | null> {
    return this.clients.get(clientId) ?? null;
  }

  async listClients(): Promise<readonly ClientRecord[]> {
    // Stable oldest-first ordering — operators see "what registered
    // when" in chronological order, which matches how they'd reason
    // about which client is which (the most recently added is at the
    // bottom, easy to spot after a fresh connector add).
    return Array.from(this.clients.values()).sort(
      (a, b) => a.createdAt - b.createdAt,
    );
  }

  async deleteClient(clientId: string): Promise<void> {
    // Idempotent — Map.delete returns false if the key wasn't there;
    // we discard that signal so callers can DELETE freely without a
    // pre-check. Matches REST conventions.
    this.clients.delete(clientId);
  }
}

// =============================================================================
// URL + metadata helpers
// =============================================================================

/**
 * Resolve the public origin for OAuth metadata. Prefer the configured
 * {@link OAuthConfig.issuerUrl} (operator-controlled, deterministic);
 * fall back to deriving from the request's forwarded headers (works
 * behind nginx-ingress + ALB which both set X-Forwarded-Proto / -Host).
 */
export function resolveIssuerUrl(req: Request, configured?: string): string {
  if (configured) return configured.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string | undefined) ?? req.protocol;
  const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host;
  return `${proto}://${host}`;
}

/**
 * Build the `WWW-Authenticate` header value pointing at the resource-
 * metadata document. Per RFC 9728 §5, MCP-aware clients fetch this URL
 * to discover the authorization server.
 *
 * `resourcePath` (default `''`) is the path prefix the per-app metadata
 * lives under — e.g. `/apps/aB3kP9xY` → header points at
 * `${issuer}/apps/aB3kP9xY/.well-known/oauth-protected-resource` so a
 * client that 401'd on a per-app endpoint discovers the per-app
 * metadata document. Empty string preserves the
 * universal-only behavior — `${issuer}/.well-known/...` — used by the
 * universal `/mcp` route, the auth-check probe, and OSS deployments
 * without per-app routing.
 *
 * Caller must supply a leading slash (or empty string). Trailing slash
 * is normalized off so callers can pass either `/apps/x` or
 * `/apps/x/` interchangeably.
 */
export function buildWwwAuthenticate(
  issuerUrl: string,
  resourcePath: string = '',
): string {
  const normalized = resourcePath.replace(/\/$/, '');
  const resourceMetadataUrl = `${issuerUrl}${normalized}/.well-known/oauth-protected-resource`;
  return `Bearer realm="mcp", resource_metadata="${resourceMetadataUrl}"`;
}

// =============================================================================
// PKCE
// =============================================================================

function sha256Base64Url(input: string): string {
  return createHash('sha256').update(input).digest('base64url');
}

function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = sha256Base64Url(verifier);
  return computed === challenge;
}

// =============================================================================
// Route handlers
// =============================================================================

/**
 * `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata that
 * tells the client where to find the authorization server. Same origin
 * in our case (we host both the resource AND the auth server).
 *
 * `mcpPath` (default `/mcp`) is the deployment's universal MCP route.
 * Cloud `mcp.ggui.ai` mounts at the bare root `/` so URLs are short
 * (the domain already says "mcp"); OSS keeps the conventional `/mcp`.
 * The trailing slash is normalized off when the path is `/` so the
 * resource URL is `${issuer}` (no trailing slash) rather than
 * `${issuer}/`.
 */
export function handleProtectedResourceMetadata(
  req: Request,
  res: Response,
  config: OAuthConfig,
  mcpPath: string = '/mcp',
): void {
  const issuer = resolveIssuerUrl(req, config.issuerUrl);
  const resource = mcpPath === '/' ? issuer : `${issuer}${mcpPath}`;
  res.json({
    resource,
    authorization_servers: [issuer],
    bearer_methods_supported: ['header'],
    resource_documentation: 'https://modelcontextprotocol.io/extensions/apps/overview',
  });
}

/**
 * `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata
 * describing this auth server's capabilities + endpoints.
 */
export function handleAuthorizationServerMetadata(
  req: Request,
  res: Response,
  config: OAuthConfig,
): void {
  const issuer = resolveIssuerUrl(req, config.issuerUrl);
  res.json({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'], // PKCE-only, no client_secret
    scopes_supported: ['mcp'],
  });
}

/**
 * `POST /oauth/register` — RFC 7591 Dynamic Client Registration. Issues
 * a random `client_id`. No `client_secret` (PKCE-only). Accepts arbitrary
 * `redirect_uris` from the client without validation against an allowlist
 * — the trade-off matches the MCP spec's pragmatism: any client willing
 * to do PKCE + paste-key gets registered.
 */
export async function handleRegister(
  req: Request,
  res: Response,
  config: OAuthConfig,
  storage: OAuthStorage,
): Promise<void> {
  const body = (req.body ?? {}) as {
    redirect_uris?: unknown;
    client_name?: unknown;
  };
  const redirectUrisRaw = body.redirect_uris;
  if (!Array.isArray(redirectUrisRaw) || redirectUrisRaw.length === 0) {
    res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: '`redirect_uris` array is required',
    });
    return;
  }
  const redirectUris = redirectUrisRaw.filter(
    (u): u is string => typeof u === 'string' && u.length > 0,
  );
  if (redirectUris.length === 0) {
    res.status(400).json({
      error: 'invalid_redirect_uri',
      error_description: '`redirect_uris` must contain at least one non-empty string',
    });
    return;
  }

  const clientId = `mcp_client_${randomBytes(16).toString('base64url')}`;
  const clientName =
    typeof body.client_name === 'string' ? body.client_name : undefined;

  await storage.putClient({
    clientId,
    redirectUris,
    ...(clientName !== undefined ? { clientName } : {}),
    createdAt: Date.now(),
  });

  res.status(201).json({
    client_id: clientId,
    redirect_uris: redirectUris,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
    ...(clientName !== undefined ? { client_name: clientName } : {}),
  });
}

/**
 * `GET /oauth/authorize` — render the paste-key form. Query params
 * (per OAuth 2.1 + PKCE):
 *   - `client_id` — from DCR
 *   - `redirect_uri` — must match one registered at DCR time
 *   - `response_type=code`
 *   - `code_challenge` — base64url(SHA256(code_verifier))
 *   - `code_challenge_method=S256`
 *   - `state` — opaque, echoed back to client
 *   - `scope` — ignored (we don't gate by scope today)
 *
 * The page is intentionally minimal — server-rendered HTML, no JS
 * required, no external CDN. The form POSTs back to `/oauth/authorize`
 * with the user's pasted key.
 */
export async function handleAuthorizeGet(
  req: Request,
  res: Response,
  config: OAuthConfig,
  storage: OAuthStorage,
): Promise<void> {
  const params = req.query as Record<string, string | undefined>;
  const issuer = resolveIssuerUrl(req, config.issuerUrl);
  const v = await validateAuthorizeParams(params, storage, config, issuer);
  if ('error' in v) {
    res.status(400).type('html').send(renderErrorPage(v.error));
    return;
  }

  // Delegate to external consent UI when configured. Forward every
  // OAuth param verbatim — the consent UI doesn't need to know which
  // params are which, just that it must echo them back on POST. We
  // also forward `mcp_origin` so the consent UI knows where to POST
  // back without needing per-environment build-time config.
  if (config.consentUrl) {
    const target = new URL(config.consentUrl);
    for (const [k, val] of Object.entries(params)) {
      if (typeof val === 'string') target.searchParams.set(k, val);
    }
    target.searchParams.set('mcp_origin', resolveIssuerUrl(req, config.issuerUrl));
    res.redirect(302, target.toString());
    return;
  }

  // Forward all params back to the form so POST handler has them.
  // Includes `code_challenge`, `state`, etc.
  res.type('html').send(renderAuthorizePage(params));
}

/**
 * `POST /oauth/authorize` — handle paste-key form submission. Validates
 * the key against the configured {@link AuthAdapter} (same one that
 * gates `/mcp`), mints an auth code, redirects to client's
 * `redirect_uri` with `?code=...&state=...`.
 *
 * Validation flow:
 *   1. Re-validate the OAuth params (defense — caller could skip /GET).
 *   2. Resolve the pasted key through `auth.authenticate()` — accepts
 *      any key the adapter accepts. For ggui this means `ggui_user_*`
 *      keys validated against `GguiUserApiKey` table via the existing
 *      `lookupUser` binding.
 *   3. On success: write {code, accessToken=key, codeChallenge,
 *      redirectUri, clientId} to storage. 5-minute TTL.
 *   4. Redirect to `redirect_uri?code=<code>&state=<state>`.
 *   5. On bad key: re-render the page with an error message (preserves
 *      OAuth params).
 */
export async function handleAuthorizePost(
  req: Request,
  res: Response,
  config: OAuthConfig,
  storage: OAuthStorage,
  auth: AuthAdapter,
  pairingService?: PairingService | null,
): Promise<void> {
  const params = (req.body ?? {}) as Record<string, string | undefined>;
  const issuer = resolveIssuerUrl(req, config.issuerUrl);
  const validation = await validateAuthorizeParams(
    params,
    storage,
    config,
    issuer,
  );
  if ('error' in validation) {
    res.status(400).type('html').send(renderErrorPage(validation.error));
    return;
  }

  // Two paths: operator either types the short pair code printed on the
  // terminal banner, OR pastes a previously-paired bearer. Both resolve
  // to the same per-server access_token used below — claude.ai never
  // sees which path was used.
  let apiKey: string | undefined;
  const pairCode = params['pair_code']?.trim();
  const pastedKey = params['api_key']?.trim();

  if (pairCode && pairCode.length > 0 && pairingService) {
    try {
      const completion = await pairingService.completePairing({
        code: pairCode,
        deviceName: `OAuth: ${params['client_id'] ?? 'unknown-client'}`,
      });
      apiKey = completion.token;
    } catch {
      res
        .status(401)
        .type('html')
        .send(
          renderAuthorizePage(params, 'Pair code expired or invalid — restart the server for a fresh code.'),
        );
      return;
    }
  } else if (pastedKey && pastedKey.length > 0) {
    apiKey = pastedKey;
  } else {
    res.status(400).type('html').send(renderAuthorizePage(params, 'Pair code or API key required'));
    return;
  }

  // Validate the key by running the adapter's auth path. We synthesize a
  // minimal Request shape — the adapter only reads `headers` for bearer
  // extraction. Using the real `resolveIdentity()` keeps the validation
  // semantics byte-identical to /mcp's auth gate.
  const fakeReq = {
    headers: { authorization: `Bearer ${apiKey}` },
  } as unknown as Request;
  try {
    await resolveIdentity(auth, fakeReq);
  } catch (err) {
    if (err instanceof UnauthenticatedError) {
      res
        .status(401)
        .type('html')
        .send(renderAuthorizePage(params, 'Invalid API key — try again.'));
      return;
    }
    throw err;
  }

  // Mint auth code. 32 bytes random → base64url ≈ 43 chars.
  const code = randomBytes(32).toString('base64url');
  const FIVE_MINUTES_MS = 5 * 60 * 1000;
  // RFC 8707 §2 — capture the resource indicator so /token can
  // enforce the same target on exchange. Absence is permitted (the
  // record's `resource` stays undefined; tokens issued under that
  // code carry universal scoping).
  const resource = params['resource'];
  await storage.putAuthCode({
    code,
    accessToken: apiKey,
    codeChallenge: params['code_challenge']!,
    redirectUri: params['redirect_uri']!,
    clientId: params['client_id']!,
    expiresAt: Date.now() + FIVE_MINUTES_MS,
    ...(typeof resource === 'string' && resource.length > 0
      ? { resource }
      : {}),
  });

  // Snapshot the resource + authorize timestamp onto the client
  // record (Q7 RESOLVED 2026-05-06). Lets the operator's Connected
  // Apps console surface "Connected to: <App>" without the
  // listClients caller having to join against the auth-code table
  // (which is short-lived; codes have already been consumed by the
  // time the operator opens the page). Best-effort — failure to
  // snapshot doesn't fail the authorize flow; the client just
  // shows "Universal" in the UI until the next authorize.
  try {
    const client = await storage.getClient(params['client_id']!);
    if (client) {
      await storage.putClient({
        ...client,
        lastAuthorizeAt: Date.now(),
        ...(typeof resource === 'string' && resource.length > 0
          ? { lastResource: resource }
          : {}),
      });
    }
  } catch {
    // Swallow — auth flow stays green even if the client-record
    // snapshot fails. The user gets their token; UI display is the
    // only thing that lags.
  }

  // Build redirect URL — preserve the client's `state`.
  const redirectUrl = new URL(params['redirect_uri']!);
  redirectUrl.searchParams.set('code', code);
  if (params['state']) redirectUrl.searchParams.set('state', params['state']);
  res.redirect(302, redirectUrl.toString());
  void config; // Reserved for future per-issuer overrides.
}

/**
 * `POST /oauth/token` — exchange auth code for access token. RFC 6749
 * §4.1.3 + RFC 7636 (PKCE).
 *
 * Request body (form-urlencoded or JSON):
 *   - `grant_type=authorization_code`
 *   - `code` — from the redirect
 *   - `redirect_uri` — must match what was passed at /authorize
 *   - `client_id` — from DCR
 *   - `code_verifier` — PKCE verifier (raw, server hashes + compares)
 *
 * Response:
 *   - `access_token` — the user's `ggui_user_*` key (stored from /authorize)
 *   - `token_type=Bearer`
 *   - `expires_in` — omitted; key TTL matches the underlying API key
 *
 * Errors per RFC 6749 §5.2 — JSON body with `{error, error_description}`,
 * 400 status code.
 */
export async function handleToken(
  req: Request,
  res: Response,
  storage: OAuthStorage,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, string | undefined>;

  if (body['grant_type'] !== 'authorization_code') {
    res.status(400).json({
      error: 'unsupported_grant_type',
      error_description: 'only `authorization_code` is supported',
    });
    return;
  }

  const code = body['code'];
  const redirectUri = body['redirect_uri'];
  const clientId = body['client_id'];
  const codeVerifier = body['code_verifier'];

  if (!code || !redirectUri || !clientId || !codeVerifier) {
    res.status(400).json({
      error: 'invalid_request',
      error_description:
        '`code`, `redirect_uri`, `client_id`, `code_verifier` all required',
    });
    return;
  }

  const record = await storage.consumeAuthCode(code);
  if (!record) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'code expired or already consumed',
    });
    return;
  }

  if (record.redirectUri !== redirectUri) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'redirect_uri mismatch',
    });
    return;
  }
  if (record.clientId !== clientId) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'client_id mismatch',
    });
    return;
  }
  if (!verifyPkce(codeVerifier, record.codeChallenge)) {
    res.status(400).json({
      error: 'invalid_grant',
      error_description: 'PKCE verification failed',
    });
    return;
  }

  // RFC 8707 §2.2 — when the original /authorize request included a
  // resource indicator, the token request MAY include it; if the
  // client sends one, it MUST match the resource captured on the
  // auth code. Mismatch → `invalid_target` (RFC 8707 §2). Absence on
  // the request is tolerated even when the code has a resource —
  // RFC 8707 only mandates the constraint when the client opts in.
  const tokenResource = body['resource'];
  if (
    typeof tokenResource === 'string' &&
    tokenResource.length > 0 &&
    record.resource !== undefined &&
    record.resource !== tokenResource
  ) {
    res.status(400).json({
      error: 'invalid_target',
      error_description: '`resource` does not match the authorization request',
    });
    return;
  }

  res.json({
    access_token: record.accessToken,
    token_type: 'Bearer',
    scope: 'mcp',
  });
}

// =============================================================================
// Validation
// =============================================================================

async function validateAuthorizeParams(
  params: Record<string, string | undefined>,
  storage: OAuthStorage,
  config?: OAuthConfig,
  issuer?: string,
): Promise<{ valid: true } | { error: string }> {
  if (params['response_type'] !== 'code') {
    return { error: 'response_type must be `code`' };
  }
  const clientId = params['client_id'];
  if (!clientId) return { error: 'client_id required' };
  const client = await storage.getClient(clientId);
  if (!client) return { error: 'unknown client_id (re-register via DCR)' };

  const redirectUri = params['redirect_uri'];
  if (!redirectUri) return { error: 'redirect_uri required' };
  if (!client.redirectUris.includes(redirectUri)) {
    return { error: 'redirect_uri not registered for this client' };
  }
  if (!params['code_challenge']) return { error: 'code_challenge required (PKCE)' };
  if (params['code_challenge_method'] !== 'S256') {
    return { error: 'code_challenge_method must be `S256`' };
  }

  // RFC 8707 §2 resource-indicator validation.
  // Optional param — absence means universal scoping. When present
  // and a `validateResource` callback is configured, run it. Reject
  // with `invalid_target` (the canonical RFC 8707 error code) at
  // /authorize time so the user sees the failure before consent
  // rather than after PKCE exchange.
  const resource = params['resource'];
  if (typeof resource === 'string' && resource.length > 0) {
    if (config?.validateResource && issuer) {
      if (!config.validateResource(issuer, resource)) {
        return {
          error:
            'invalid_target — `resource` does not name a known MCP endpoint on this server',
        };
      }
    }
  }

  return { valid: true };
}

// =============================================================================
// HTML rendering
// =============================================================================

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * `renderShell` — page frame mirroring the console brand kit.
 *
 * Emits doctype + head + cherry-picked CSS + sticky nav (wordmark +
 * "ggui mcp-server" brand chip) + a `SectionHead`-style header
 * (`num / title / mute`) + the supplied body. Both
 * `renderAuthorizePage` and `renderErrorPage` call into it so the
 * shell + tokens stay identical across pages.
 *
 * The CSS is a hand-picked subset of `packages/console/src/index.css`
 * (tokens, nav, section head, card, button, field, mute, code,
 * callout) — the OAuth pages are server-rendered HTML and don't ship
 * the console SPA bundle, so the rules must be inline. Kept under
 * ~3 KB by dropping rules the OAuth flow never uses (hero, pane,
 * stack, codebox, traffic dots, dark-mode overrides — the brand
 * kit's Premise is paper-on-ink, no dark variant defined).
 *
 * The wordmark SVG is a copy of `packages/console/src/routes/Wordmark.tsx`
 * (mirror variant) inlined into the markup. < 1 KB, no font dep.
 */
function renderShell(
  sectionNum: string,
  sectionTitle: string,
  sectionMute: string,
  bodyHtml: string,
  pageTitle: string,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(pageTitle)}</title>
<style>
:root{--ggui-ink:#292929;--ggui-ink-2:#3d3d3d;--ggui-ink-3:#5a5a5a;--ggui-ink-4:#8c8c93;--ggui-paper:#f4f3ed;--ggui-paper-2:#ebe9e1;--ggui-line-2:#d6d4cb;--ggui-signal:#d93822;--ggui-sans:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--ggui-mono:ui-monospace,'SF Mono',Menlo,Consolas,monospace;color-scheme:light}
*,*::before,*::after{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--ggui-paper);color:var(--ggui-ink);font-family:var(--ggui-sans)}
.ggui-shell{min-height:100vh;display:flex;flex-direction:column}
.ggui-nav{position:sticky;top:0;z-index:100;background:rgba(244,243,237,0.92);backdrop-filter:saturate(1.2) blur(8px);-webkit-backdrop-filter:saturate(1.2) blur(8px);border-bottom:1px solid var(--ggui-line-2)}
.ggui-nav__inner{display:flex;align-items:center;gap:16px;max-width:820px;margin:0 auto;padding:14px 32px}
.ggui-nav__brand{font-family:var(--ggui-mono);font-size:10px;letter-spacing:0.22em;text-transform:uppercase;padding:4px 8px;background:var(--ggui-ink);color:var(--ggui-paper);border-radius:2px;font-weight:500}
.ggui-main{flex:1;width:100%;max-width:820px;margin:0 auto;padding:0 32px}
.ggui-section{padding:56px 0}
.ggui-section__head{display:grid;grid-template-columns:100px 1fr;gap:24px;margin-bottom:32px;align-items:start}
.ggui-section__num{font-family:var(--ggui-mono);font-size:11px;letter-spacing:0.18em;color:var(--ggui-ink-4);text-transform:uppercase;padding-top:6px}
.ggui-section__title{margin:0;font-size:32px;font-weight:700;letter-spacing:-0.02em;line-height:1.05}
.ggui-mute{color:var(--ggui-ink-4);font-weight:500}
.ggui-card{border:1px solid var(--ggui-line-2);background:var(--ggui-paper);border-radius:2px;padding:24px}
.ggui-stack{display:flex;flex-direction:column;gap:14px}
.ggui-label{font-family:var(--ggui-mono);font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--ggui-ink-4);font-weight:500}
.ggui-field{display:flex;align-items:stretch;border:1px solid var(--ggui-ink);background:var(--ggui-paper);border-radius:2px}
.ggui-field::before{content:'';width:4px;background:var(--ggui-ink);flex-shrink:0}
.ggui-field input{flex:1;border:0;background:transparent;padding:10px 12px;font-family:var(--ggui-mono);font-size:13px;outline:none;min-width:0;color:inherit}
.ggui-field input::placeholder{color:var(--ggui-ink-4)}
.ggui-field:focus-within{box-shadow:inset 0 0 0 1px var(--ggui-ink)}
.ggui-btn{display:inline-flex;align-items:center;gap:10px;padding:10px 18px;font-family:var(--ggui-mono);font-size:12px;letter-spacing:0.08em;text-transform:uppercase;background:var(--ggui-ink);color:var(--ggui-paper);border:1px solid var(--ggui-ink);border-radius:2px;cursor:pointer;font-weight:500;transition:background-color 0.15s ease}
.ggui-btn:hover{background:var(--ggui-ink-2);border-color:var(--ggui-ink-2)}
.ggui-btn__dot{width:6px;height:6px;background:currentColor;border-radius:50%;flex-shrink:0}
.ggui-code{font-family:var(--ggui-mono);font-size:0.9em;background:var(--ggui-paper-2);border:1px solid var(--ggui-line-2);padding:1px 6px;border-radius:2px}
.ggui-muted{margin:0;font-size:13px;line-height:1.55;color:var(--ggui-ink-3)}
.ggui-callout{display:flex;gap:10px;border:1px solid var(--ggui-signal);background:var(--ggui-paper);padding:10px 14px;border-radius:2px;font-size:13px;color:var(--ggui-ink-2)}
.ggui-callout::before{content:'';width:4px;background:var(--ggui-signal);flex-shrink:0;margin:-10px -10px -10px -14px}
.ggui-callout__label{font-family:var(--ggui-mono);font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:var(--ggui-signal);font-weight:500;margin-right:8px}
@media (max-width:620px){.ggui-section__head{grid-template-columns:1fr;gap:8px}}
</style>
</head>
<body>
<div class="ggui-shell">
<header class="ggui-nav"><div class="ggui-nav__inner">
<svg viewBox="0 0 224 50" width="84" height="19" aria-label="ggui">
<path d="M 0 0 H 50 V 25 H 25 V 50 H 0 Z" fill="#d9d9d9"/><rect x="33" y="33" width="17" height="17" fill="#292929"/>
<path d="M 58 0 H 108 V 25 H 83 V 50 H 58 Z" fill="#292929"/><rect x="91" y="33" width="17" height="17" fill="#d9d9d9"/>
<path d="M 141 50 C 154.807 50 166 38.8071 166 25 V 0 H 116 V 25 C 116 38.8071 127.193 50 141 50 Z" fill="#292929"/>
<rect x="174" y="0" width="50" height="50" fill="#d9d9d9"/>
</svg>
<span class="ggui-nav__brand" aria-label="community edition">community</span>
</div></header>
<main class="ggui-main"><section class="ggui-section">
<header class="ggui-section__head">
<div class="ggui-section__num">${escapeHtml(sectionNum)}</div>
<div>
<h2 class="ggui-section__title">${escapeHtml(sectionTitle)}<span class="ggui-mute"> ${escapeHtml(sectionMute)}</span></h2>
</div>
</header>
${bodyHtml}
</section></main>
</div>
</body>
</html>`;
}

function renderAuthorizePage(
  params: Record<string, string | undefined>,
  errorMessage?: string,
): string {
  // Forward every OAuth param as a hidden input so the POST handler
  // sees the same shape as /GET — no client-side state stash needed.
  const hiddenFields = (
    [
      'client_id',
      'redirect_uri',
      'response_type',
      'code_challenge',
      'code_challenge_method',
      'state',
      'scope',
    ] as const
  )
    .map((name) => {
      const v = params[name];
      return v
        ? `<input type="hidden" name="${name}" value="${escapeHtml(v)}">`
        : '';
    })
    .join('');

  const errorCallout = errorMessage
    ? `<div class="ggui-callout"><span class="ggui-callout__label">error</span><span>${escapeHtml(errorMessage)}</span></div>`
    : '';

  const body = `<div class="ggui-card"><form method="POST" action="/oauth/authorize" class="ggui-stack">
${errorCallout}
<label for="pair_code" class="ggui-label">Pair code</label>
<div class="ggui-field"><input type="text" id="pair_code" name="pair_code" placeholder="000000" inputmode="numeric" autocomplete="off" autofocus pattern="[0-9]{6}" maxlength="6"></div>
<p class="ggui-muted">The 6-digit code printed on your terminal when you ran <span class="ggui-code">ggui serve</span>. One-shot — restart the server for a fresh code.</p>
<details>
<summary class="ggui-muted" style="cursor:pointer;font-size:12px">Have an API key instead?</summary>
<div style="margin-top:10px">
<label for="api_key" class="ggui-label">API key</label>
<div class="ggui-field"><input type="password" id="api_key" name="api_key" placeholder="ggui_user_…" autocomplete="off"></div>
</div>
</details>
${hiddenFields}
<div><button type="submit" class="ggui-btn"><span class="ggui-btn__dot"></span>Authorize</button></div>
</form></div>`;

  return renderShell(
    '01 / authorize',
    'Authorize MCP connection.',
    'An OAuth client is requesting access to this server.',
    body,
    'Authorize MCP Connection',
  );
}

function renderErrorPage(message: string): string {
  const body = `<div class="ggui-card"><div class="ggui-stack">
<div class="ggui-callout"><span class="ggui-callout__label">error</span><span>${escapeHtml(message)}</span></div>
<p class="ggui-muted">Close this tab and retry from your client. If the problem persists, the request was rejected before reaching the consent step.</p>
</div></div>`;

  return renderShell(
    '00 / error',
    'OAuth error.',
    'The request could not be processed.',
    body,
    'OAuth Error',
  );
}
