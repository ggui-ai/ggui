/**
 * Bearer-token authentication for the self-hostable registry server.
 *
 * The transport-layer translator between an HTTP `Authorization` header
 * and the registry-core {@link AuthnContext}. Operates only on a
 * constant-time-compared static token configured at server boot —
 * any per-request rotation, multi-tenant key-pinning, or audience
 * checks belong to a reverse proxy in front of this server.
 *
 * Vendor-neutral surface: no string in this module names a specific
 * identity provider (no "OAuth", no "JWT", no cloud-vendor enum). A
 * deployment fronted by a managed identity provider would supply its
 * own `AuthnContext` adapter instead of this one.
 *
 * ## Protocol & Contract Bar
 *
 * **Parties:**
 * - Producer: the HTTP server's `/publish` middleware. Reads the
 *   request's `Authorization` header and invokes {@link BearerAuthn.verify}.
 * - Consumer: {@link publishArtifact} (via the route handler that
 *   wraps it). Reads the `subject` field and uses it as the partition
 *   key for AuthorKey lookups + the `publishedBy` field on rows.
 *
 * **Obligations:**
 * - {@link BearerAuthn.verify} MUST compare the candidate token in
 *   constant time relative to the candidate length. A naive `===`
 *   string compare leaks the configured token over a timing side
 *   channel; the OSS server treats this as a load-bearing invariant.
 * - {@link BearerAuthn.verify} MUST return `null` (not throw) on
 *   any failure — missing header, malformed scheme, token mismatch.
 *   The route handler decides the HTTP status code (401 in every case
 *   today; a future tier may surface 403 for known-but-revoked tokens
 *   and the discrimination would happen above this layer).
 *
 * **Failure mode:**
 * - All verification failures collapse to `null`. The route handler
 *   emits 401 with `{ error: 'unauthorized', message: ... }`.
 *
 * **Observable violation:**
 * - The integration test in `server.test.ts` exercises three negative
 *   paths (no header, wrong scheme, bad token) and asserts identical
 *   401 responses. Any divergence — a different status, a leaked
 *   token hint in the body — is a contract violation.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AuthnContext } from '@ggui-ai/registry-core';

export interface CreateBearerAuthnOptions {
  /**
   * The configured shared secret. The server constant-time compares the
   * incoming `Authorization: Bearer <token>` against this value.
   *
   * MUST be a non-empty string. Empty / undefined tokens would make
   * every request authenticated — the CLI rejects this at boot.
   */
  readonly token: string;
  /**
   * The subject ({@link AuthnContext.subject}) issued for successful
   * authentications. Operator-supplied so the AuthorKeys rows match a
   * known identity. Defaults to a short hash prefix of the token —
   * stable across restarts, never logs the secret.
   */
  readonly subject?: string;
}

export interface BearerAuthn {
  /**
   * Verify an `Authorization` header. Returns an {@link AuthnContext}
   * on success; `null` on any failure (missing, malformed, mismatch).
   * Constant-time compare against the configured token.
   */
  verify(authorizationHeader: string | undefined): AuthnContext | null;
}

const BEARER_PREFIX = 'Bearer ';

export function createBearerAuthn(options: CreateBearerAuthnOptions): BearerAuthn {
  if (typeof options.token !== 'string' || options.token.length === 0) {
    throw new Error(
      'createBearerAuthn: `token` is required and must be a non-empty string',
    );
  }

  const expected = Buffer.from(options.token, 'utf8');
  const subject = options.subject ?? defaultSubject(options.token);

  return {
    verify(authorizationHeader) {
      if (typeof authorizationHeader !== 'string') return null;
      if (!authorizationHeader.startsWith(BEARER_PREFIX)) return null;

      const candidate = authorizationHeader.slice(BEARER_PREFIX.length);
      if (candidate.length === 0) return null;

      const candidateBuffer = Buffer.from(candidate, 'utf8');

      // `timingSafeEqual` requires both buffers to be the same length.
      // The length-comparison short-circuit IS observable, but the
      // ggui registry's deployment model assumes the token length is
      // public knowledge (no length-based fingerprinting risk). We
      // still compare lengths first to satisfy the API contract.
      if (candidateBuffer.length !== expected.length) return null;
      if (!timingSafeEqual(candidateBuffer, expected)) return null;

      return { subject };
    },
  };
}

/**
 * Compose a stable, non-secret subject from the token. Hash prefix
 * (first 12 hex chars of SHA-256) so two operators sharing the same
 * token surface as the same `publishedBy` value — desirable because
 * a single configured token IS a single logical publisher.
 *
 * **Deployment posture.** This collapses-to-one-subject behavior is
 * the intended design for single-operator deployments (one team, one
 * shared token, one logical publisher identity). It is **NOT safe
 * for multi-operator deployments** where multiple humans or services
 * share the same bearer token: every `POST /author-keys` registration
 * and every `publishedBy` field on `ArtifactVersionRow` will land
 * under a single `bearer-<hash>` subject, erasing per-operator
 * attribution and partitioning of the `AuthorKeys` table. In that
 * regime, operators MUST run separate server instances each with a
 * distinct token AND an explicit `options.subject` per operator
 * (e.g. `subject: 'alice@team.example'`), or front the registry with
 * a reverse proxy that performs real identity verification and
 * forwards a per-request subject downstream. The OSS bearer surface
 * exists for self-hosted single-publisher convenience — multi-tenant
 * deployments belong behind a real identity provider or a
 * proxy-mediated identity tier.
 */
function defaultSubject(token: string): string {
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  return `bearer-${digest.slice(0, 12)}`;
}
