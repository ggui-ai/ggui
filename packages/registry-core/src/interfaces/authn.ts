/**
 * Post-verification authenticated caller context.
 *
 * Vendor-neutral — registry-core's API never names a specific identity
 * provider (no JWT, no bearer, no cloud-vendor enum). Verification is
 * transport-specific: cloud handlers verify a JWT from the platform's
 * hosted auth surface and produce an `AuthnContext`; the OSS server
 * verifies a bearer token and produces an `AuthnContext`. Once
 * registry-core has the context, it only knows WHO is calling, not
 * HOW they proved it.
 *
 * Authz decisions (org membership, role checks) happen above this
 * layer — registry-core treats the subject as a stable opaque caller
 * identity and uses it as the partition key for AuthorKeys lookups +
 * the `publishedBy` field on rows.
 *
 * ## Protocol & Contract Bar
 *
 * **Parties:** the registry transport (cloud Lambda or OSS hono
 * server) is the producer; registry-core's ops are the consumer.
 *
 * **Obligations:** the producer MUST verify the caller's credentials
 * (JWT signature, bearer-token constant-time compare, …) before
 * constructing this context. Registry-core takes the subject on
 * trust — if the transport constructs an `AuthnContext` without
 * verification, every downstream invariant breaks (the registry would
 * mint rows on behalf of arbitrary callers).
 *
 * **Failure mode:** the transport returns 401/403 BEFORE invoking a
 * registry-core op. Registry-core operations MAY accept an
 * `AuthnContext | undefined` parameter when the operation has a
 * public-readable path (read, search public artifacts); the op then
 * branches internally on the visibility of the requested row.
 *
 * **Observable violation:** if a registry op writes a row with
 * `publishedBy: ctx.subject` and the row is later retrieved + the
 * subject doesn't correspond to a real identity in the transport's
 * verification system, the row is forged — visible to the operator
 * via audit logs that show no matching credential issued for that
 * subject.
 */
export interface AuthnContext {
  /**
   * Stable, opaque caller identity. Cloud transport: hosted-auth `sub`
   * claim. OSS bearer: a configured user identifier the operator chose
   * to associate with the token (or a hash of the token itself when no
   * identifier is configured).
   */
  readonly subject: string;
}
