/**
 * OidcJwtAuthAdapter — neutral, config-driven JWT verify adapter.
 *
 * Uses structural verifier injection: a {@link JwtVerifierLike} lets tests
 * inject a mock verifier, while the real JWKS / signature / expiry
 * verification is delegated to that verifier (its library is tested
 * upstream). This module is the verifier-injected path — all adapter logic
 * (issuer selection, `aud` pattern + appId extraction, userId namespacing,
 * fixed minimal roles, collapse-to-null on any failure).
 * The production path delegates concrete JWKS/signature verification to a
 * {@link VerifierFactory} injected by the consumer (e.g. `buildAwsJwtVerifier`
 * in the cloud pod, which depends on `aws-jwt-verify`). This OSS core imports
 * NO JWKS library — the AWS-coupled dependency lives in the consumer, so a
 * deployment that never federates pulls nothing in. With neither an injected
 * factory nor a per-row verifier, federation fails closed.
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
  /**
   * Per-issuer alg allowlist for the lazily-built prod verifier. Enforced via
   * the verifier's `customJwtCheck` hook — the JWT header `alg` MUST be a member
   * (spec §A.4 step 3). When omitted, the library's built-in defaults still
   * block `alg:none` and RS↔HS confusion.
   */
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

/**
 * Builds a concrete {@link JwtVerifierLike} for a trusted issuer row. Injected
 * by the CONSUMER (e.g. the cloud pod, via `aws-jwt-verify`) so the concrete
 * JWKS-verification library stays OUT of this OSS core: the published package
 * never imports an AWS-coupled dependency, and a deployment that doesn't
 * federate never pulls one in. (Mirrors the repo's cloud boundary rule —
 * AWS-coupled code lives in `cloud/`, behind a neutral port like this.)
 */
export type VerifierFactory = (row: TrustedIssuerRow) => JwtVerifierLike;

export class OidcJwtAuthAdapter implements AuthAdapter {
  private readonly byIssuer: Map<string, TrustedIssuerRow>;
  private readonly buildVerifier: VerifierFactory | undefined;

  /**
   * @param rows trusted issuers.
   * @param buildVerifier consumer-supplied factory that constructs the concrete
   *   verifier from a row's JWKS config (omit when verifiers are injected
   *   per-row via `row.verifier`, e.g. in tests). With neither, federation
   *   fails closed (`verifier_unavailable`).
   */
  constructor(rows: readonly TrustedIssuerRow[], buildVerifier?: VerifierFactory) {
    this.byIssuer = new Map(rows.map((r) => [r.issuer, r]));
    this.buildVerifier = buildVerifier;
  }

  /**
   * Server-side observability for a rejected federated token. NOT a caller
   * leak — `authenticate` still returns `null` to the caller (the "collapse,
   * no leak" posture holds); this only surfaces WHY in the host's logs so a
   * misconfig / transit / claim issue is diagnosable instead of an opaque 401.
   * Logs no secret — `iss`/`aud` are public, `error` is the verifier's reason.
   */
  private rejected(stage: string, extra?: Record<string, unknown>): null {
    // eslint-disable-next-line no-console
    console.warn('oidc_reject', { stage, ...extra });
    return null;
  }

  async authenticate(token: string): Promise<AuthResult | null> {
    if (!token) return null;
    const iss = unverifiedIss(token);
    if (!iss) return this.rejected('unverified_iss_parse');
    const row = this.byIssuer.get(iss); // EXACT match only
    if (!row) return this.rejected('issuer_not_trusted', { iss });
    const verifier = this.getVerifier(row);
    if (!verifier) return this.rejected('verifier_unavailable', { iss });

    let payload: OidcPayloadShape;
    try {
      payload = (await verifier.verify(token)) as OidcPayloadShape;
    } catch (e) {
      // bad sig / expiry / wrong-iss / wrong-aud — collapse to null (no
      // caller leak) but log the verifier's reason server-side.
      return this.rejected('verify_threw', {
        iss,
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      });
    }
    if (!payload || typeof payload.sub !== 'string' || typeof payload.iss !== 'string') {
      return this.rejected('payload_missing_sub_or_iss');
    }
    if (payload.iss !== row.issuer) return this.rejected('iss_mismatch', { iss }); // defense: verified iss must match the row

    const aud = audString(payload.aud);
    if (aud === null) return this.rejected('aud_not_single_string');
    const audMatch = row.audiencePattern.exec(aud);
    if (!audMatch || !audMatch[1]) return this.rejected('aud_pattern_no_match', { aud }); // aud must match the row pattern
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

  /**
   * Resolve the verifier for a row. Order: explicit per-row `row.verifier`
   * (tests / direct injection) → cached → built via the injected
   * {@link VerifierFactory}. This OSS core never imports a concrete JWKS
   * library; the consumer (e.g. the cloud pod, via `aws-jwt-verify`) owns that
   * dependency and the build details (alg pinning, `audience:null` since the
   * adapter checks `aud` against the row pattern itself). No factory AND no
   * per-row verifier ⇒ `null` (the caller logs `verifier_unavailable` and
   * rejects, fail-closed).
   */
  protected getVerifier(row: TrustedIssuerRow): JwtVerifierLike | null {
    if (row.verifier) return row.verifier;
    const cached = this.built.get(row.issuer);
    if (cached) return cached;
    if (!this.buildVerifier) return null;
    try {
      const v = this.buildVerifier(row);
      this.built.set(row.issuer, v);
      return v;
    } catch {
      return null; // factory failure → fail-closed (never crash)
    }
  }
}
