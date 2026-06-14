/**
 * OidcJwtAuthAdapter — neutral, config-driven JWT verify adapter.
 *
 * Uses structural verifier injection: a {@link JwtVerifierLike} lets tests
 * inject a mock verifier, while the real JWKS / signature / expiry
 * verification is delegated to that verifier (its library is tested
 * upstream). This module is the verifier-injected path — all adapter logic
 * (issuer selection, `aud` pattern + appId extraction, userId namespacing,
 * fixed minimal roles, collapse-to-null on any failure).
 * The production path lazily builds a verifier from a row's JWKS config via
 * the OPTIONAL `aws-jwt-verify` peerDep (mirrors `better-sqlite3`); deployments
 * that never federate an OIDC issuer never load it.
 *
 * Security posture:
 *   - Exact `iss` registry match for verifier selection; the verifier then
 *     cryptographically enforces `iss` again, and the verified `iss` is
 *     re-checked against the selected row (defense in depth).
 *   - `aud` must match the row's anchored pattern; capture group 1 is the
 *     appId. Multi-`aud` tokens are rejected — they are not single-app
 *     resource indicators.
 *   - Roles are a FIXED minimal set — never read from the token.
 *   - Any verification or shape failure collapses to `null` (no leak).
 */
import type {
  AuthAdapter,
  AuthRequest,
  AuthResult,
  Identity,
} from './auth-adapter.js';
import { composeOAuthUserId } from '@ggui-ai/protocol';

/** Subset of a JWT verifier (e.g. aws-jwt-verify JwtRsaVerifier) the adapter uses. */
export interface JwtVerifierLike {
  /** Resolves the verified payload, or throws on any verification failure. */
  verify(token: string): Promise<unknown>;
}

/** One trusted issuer. Each deployment supplies its own set of these. */
export interface TrustedIssuerRow {
  /** Short stable id used to namespace userIds, e.g. 'acme'. Colon-free. */
  readonly providerId: string;
  /** Exact `iss` this row matches. */
  readonly issuer: string;
  /** Anchored RegExp the `aud` claim must match (e.g. /^https:\/\/mcp\.ggui\.ai\/apps\/[A-Za-z0-9_-]+$/). */
  readonly audiencePattern: RegExp;
  /** Pre-built verifier (test/explicit path) OR JWKS config (prod path). */
  readonly verifier?: JwtVerifierLike;
  readonly jwksUrl?: string;
  /** Per-issuer alg allowlist for the lazily-built prod verifier. */
  readonly alg?: readonly string[];
}

interface OidcPayloadShape {
  iss: string;
  sub: string;
  aud: string | string[];
}

/** Fixed minimal role set for a federated end-user — NEVER ops/admin. */
const FEDERATED_END_USER_ROLES: readonly string[] = [];

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header);
  if (!m || !m[1]) return null;
  const t = m[1].trim();
  return t.length > 0 ? t : null;
}

/** Read the UNVERIFIED `iss` from a JWT payload — used ONLY to select a
 *  registry row. The row's verifier then cryptographically enforces iss. */
function unverifiedIss(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf8'),
    ) as unknown;
    if (
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { iss?: unknown }).iss === 'string'
    ) {
      return (payload as { iss: string }).iss;
    }
    return null;
  } catch {
    return null;
  }
}

function audString(aud: string | string[]): string | null {
  if (typeof aud === 'string') return aud;
  if (Array.isArray(aud) && aud.length === 1 && typeof aud[0] === 'string') {
    return aud[0];
  }
  return null; // multi-aud is not a single-app resource indicator — reject
}

export class OidcJwtAuthAdapter implements AuthAdapter {
  private readonly byIssuer: Map<string, TrustedIssuerRow>;

  constructor(rows: readonly TrustedIssuerRow[]) {
    this.byIssuer = new Map(rows.map((r) => [r.issuer, r]));
  }

  async authenticate(token: string): Promise<AuthResult | null> {
    if (!token) return null;
    const iss = unverifiedIss(token);
    if (!iss) return null;
    const row = this.byIssuer.get(iss); // EXACT match only
    if (!row) return null;
    const verifier = this.getVerifier(row);
    if (!verifier) return null;

    let payload: OidcPayloadShape;
    try {
      payload = (await verifier.verify(token)) as OidcPayloadShape;
    } catch {
      return null; // bad sig / expiry / wrong-iss → collapse (no leak)
    }
    if (!payload || typeof payload.sub !== 'string' || typeof payload.iss !== 'string') {
      return null;
    }
    if (payload.iss !== row.issuer) return null; // defense: verified iss must match the row

    const aud = audString(payload.aud);
    if (aud === null) return null;
    const audMatch = row.audiencePattern.exec(aud);
    if (!audMatch || !audMatch[1]) return null; // aud must match the row pattern
    const appId = audMatch[1]; // capture group 1 = appId

    const identity: Identity = {
      kind: 'user',
      userId: composeOAuthUserId({
        providerId: row.providerId,
        providerSubject: payload.sub,
      }),
      appId,
      roles: [...FEDERATED_END_USER_ROLES], // fixed minimal — never from the token
    };
    return {
      identity,
      source: 'oidc',
      metadata: { iss: payload.iss, sub: payload.sub },
    };
  }

  async getIdentity(request: AuthRequest): Promise<AuthResult | null> {
    const token = parseBearer(
      request.headers['authorization'] ?? request.headers['Authorization'],
    );
    if (!token) return null;
    return this.authenticate(token);
  }

  private readonly built = new Map<string, JwtVerifierLike>();

  /** Test path: row carries a pre-built verifier. Prod path: build one from JWKS config. */
  protected getVerifier(row: TrustedIssuerRow): JwtVerifierLike | null {
    if (row.verifier) return row.verifier; // test/explicit path
    if (!row.jwksUrl) return null;
    const cached = this.built.get(row.issuer);
    if (cached) return cached;
    try {
      // Lazy require — aws-jwt-verify is an OPTIONAL peerDep (mirrors
      // better-sqlite3). Only deployments that federate an OIDC issuer
      // install it; everyone else never loads it.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { JwtRsaVerifier } = require('aws-jwt-verify') as {
        JwtRsaVerifier: {
          create(props: {
            issuer: string;
            audience: null; // we check aud via the row pattern ourselves
            jwksUri: string;
            jwtVerifyOptions?: { algorithms?: readonly string[] };
          }): JwtVerifierLike;
        };
      };
      const v = JwtRsaVerifier.create({
        issuer: row.issuer,
        audience: null,
        jwksUri: row.jwksUrl,
        jwtVerifyOptions: row.alg ? { algorithms: row.alg } : undefined,
      });
      this.built.set(row.issuer, v);
      return v;
    } catch {
      return null; // aws-jwt-verify absent / build failed → auth-failure, never crash
    }
  }
}
