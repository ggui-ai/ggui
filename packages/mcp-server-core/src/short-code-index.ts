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
 *   - `@ggui-ai/mcp-server-handlers/session-mutations/render` is the
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
 * agent re-pushes. Upgrading to durable storage is a post-MVP
 * concern — console's launch scenario is "ggui dev + browser in
 * the same session."
 */

/**
 * Binding stored against a shortCode. Deliberately narrow — only the
 * fields console needs to mint a session cookie. No user identity,
 * no scopes, no expiry. Adding fields here means every writer has to
 * be updated; resist.
 */
export interface ShortCodeBinding {
  readonly sessionId: string;
  readonly appId: string;
  /**
   * Render id at the moment of the bind (`stackItemId` field name
   * preserved for back-compat with already-deployed adapters that
   * persist the binding). OSS readers don't use this; hosted DDB
   * impls record it onto the rich row so the render endpoint can
   * deep-link directly to the originating render without a follow-up
   * `renderStore.get`. The mint happens upstream of the placeholder
   * render write, so the value isn't observable on `renderStore.get`
   * yet — passing it through the binding lifts the dependency from
   * "read render" to "read binding."
   *
   * Optional + ignored by the in-memory reference impl. Adding a new
   * field here is intentionally rare; this one was load-bearing for
   * the cloud pod's render-endpoint deep-link.
   */
  readonly stackItemId?: string;
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
   * Semantics when a session has multiple historical shortCodes:
   * implementations return the most-recently-bound shortCode
   * (last-writer-wins on the reverse side). Old shortCodes remain
   * valid on the forward `lookup` side; this method is for the
   * console sessions page which shows ONE shortCode per session.
   *
   * Added to support `GET /ggui/console/sessions` — the console's
   * operator-facing list surface needs to enrich each session row
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
   * `/r/<code>` URL the moment the originating session ends.
   */
  revoke(shortCode: string): Promise<void>;

  /**
   * Bulk revoke — drop every binding tied to `sessionId`. Used by
   * conversation-wide teardown paths: after every render in a host
   * conversation is closed, no outstanding render URL bound to that
   * host should still resolve.
   *
   * Semantics:
   *   - Both forward + reverse entries cleared.
   *   - Returns the count of revoked bindings (0 when none existed).
   *   - Idempotent.
   */
  revokeBySessionId(sessionId: string): Promise<number>;

  /**
   * Granular revoke — drop bindings tied to a specific render.
   * Used by `ggui_close` (and equivalent per-render teardown paths):
   * when a single render is closed, the URL pointing at that specific
   * render should stop resolving even though sibling renders in the
   * same host conversation may still have valid URLs.
   *
   * The parameter is named `stackItemId` for historical reasons; it
   * carries a `renderId`. Implementations that don't persist this
   * field on the binding MUST start persisting it to honor this call.
   * Returns the count of revoked bindings (0 when none matched).
   */
  revokeByStackItemId(stackItemId: string): Promise<number>;
}
