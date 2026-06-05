/**
 * ShortCodeIndex — shortCode → sessionId/appId lookup.
 *
 * Scope. Single narrow purpose: the console render viewer (and
 * future same-origin share-link consumers) resolve `/r/<shortCode>`
 * back to the render the handler minted the code for. The hosted
 * cloud has its own DynamoDB record path for this; OSS needs a
 * parallel in-process store because nothing else in the OSS server's
 * interfaces owns the mapping.
 *
 * Ownership / writers.
 *   - `@ggui-ai/mcp-server-handlers/renders/render` is the
 *     only writer today. After minting a `shortCode` it calls
 *     `index.put(shortCode, { sessionId, appId })` — best-effort, no
 *     throw on failure, since the tool result is already constructed
 *     by the time the write happens.
 *   - Future writers (share-link tool, programmatic API) bind the
 *     same interface.
 *
 * Consumers.
 *   - `@ggui-ai/mcp-server`'s console cookie route uses `lookup`
 *     to resolve a POSTed shortCode into the sessionId the cookie
 *     will be bound to.
 *   - Nothing else reads. In particular: `/mcp` tool handlers never
 *     consult this index — sessionId is always on the wire directly
 *     for them.
 *
 * Lifetime + eviction. Implementation choice. The in-memory reference
 * impl keeps entries unbounded; operators with bounded-memory needs
 * swap for a TTL-aware implementation. Pre-launch OSS runs on laptops
 * where scan + GC is fine.
 *
 * NOT a persistence layer. The mapping is ephemeral + same-process;
 * restarts drop every entry and the shortCode becomes a 404 until the
 * agent re-renders. Upgrading to durable storage is a post-MVP
 * concern — console's launch scenario is "ggui dev + browser in
 * the same session."
 */

/**
 * Binding stored against a shortCode. Deliberately narrow — only the
 * fields console needs to mint a session cookie. No user identity,
 * no scopes, no expiry. Adding fields here means every writer has to
 * be updated; resist.
 *
 * Post Phase-B identity collapse: `sessionId` IS the addressable unit
 * (session+stackItem merged). The previous `sessionId` + `stackItemId`
 * slot pair always held the same value at the bind site, so both
 * collapse to one `sessionId` field on the binding row.
 */
export interface ShortCodeBinding {
  readonly sessionId: string;
  readonly appId: string;
}

export interface ShortCodeIndex {
  /**
   * Record a `shortCode → { sessionId, appId }` binding. Idempotent —
   * calling with the same shortCode twice replaces the previous
   * binding. Writers don't await concurrent put calls, so
   * implementations MUST tolerate racy overlapping writes on the
   * same key (last-writer-wins is acceptable).
   */
  put(shortCode: string, binding: ShortCodeBinding): Promise<void>;

  /**
   * Return the binding for a shortCode, or `null` when absent or
   * expired. Return value MUST be a defensive copy — callers may
   * mutate the returned object (though none do today) without
   * corrupting index state.
   */
  lookup(shortCode: string): Promise<ShortCodeBinding | null>;

  /**
   * Reverse lookup — return the shortCode currently bound to
   * `sessionId`, or `null` if no binding exists.
   *
   * Semantics when a render has multiple historical shortCodes:
   * implementations return the most-recently-bound shortCode
   * (last-writer-wins on the reverse side). Old shortCodes remain
   * valid on the forward `lookup` side; this method is for the
   * console renders page which shows ONE shortCode per render.
   *
   * Added to support `GET /ggui/console/sessions` — the console's
   * operator-facing list surface needs to enrich each render row
   * with its current shortCode without iterating the whole index.
   * Hosted DDB implementations will back this by a GSI on
   * `sessionId`; the in-memory reference keeps a secondary `Map`.
   */
  findBySessionId(sessionId: string): Promise<string | null>;

  /**
   * Revoke (delete) a single binding. Idempotent — revoking an absent
   * shortCode is a no-op. After revoke, `lookup(code)` returns `null`.
   *
   * Capability-URL hardening: the render route reads `lookup` and
   * 404s on `null`, so revoking is the lifecycle hook that kills a
   * `/r/<code>` URL the moment the originating render ends.
   */
  revoke(shortCode: string): Promise<void>;

  /**
   * Bulk revoke — drop every binding tied to `sessionId`. Used by
   * render-wide teardown paths (operator-initiated cleanup,
   * tenant offboarding, test fixtures): a single call drops every URL
   * that was ever minted against the supplied id.
   *
   * Semantics:
   *   - Both forward + reverse entries cleared.
   *   - Returns the count of revoked bindings (0 when none existed).
   *   - Idempotent.
   */
  revokeBySessionId(sessionId: string): Promise<number>;
}
