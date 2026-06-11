/**
 * `@ggui-ai/gadgets/catalog-adapter`.
 *
 * The contract surface between the ggui server and a per-deployment
 * gadget catalog. The wire-side `DataContract.clientCapabilities.gadgets`
 * is intentionally narrow — it is package-keyed and carries identity
 * only (`(package, export name)`, no `version`, no transport
 * metadata), so render-time resolution looks up the matching
 * {@link GadgetDescriptor} descriptor by npm package name. This module
 * declares the pluggable "where do descriptors come from?" port + ships
 * two batteries-included implementations:
 *
 *   - {@link InMemoryGadgetCatalog} — static map, configured at
 *     construction. Right for tests, the OSS default seed, and
 *     deployments that ship a fixed catalog at boot.
 *
 *   - {@link CachingGadgetCatalog} — decorator over any other adapter
 *     with per-appId TTL caching + single-flight deduplication. Right
 *     for production paths where descriptors live in a database /
 *     a registry service and re-fetching on every render would burn
 *     network round-trips. Caches are scoped per-appId so two apps
 *     never see each other's catalogs.
 *
 * ## Design contract
 *
 *   - One method: `list(appId)`. Single batch read — never an N+1
 *     "fetch descriptor for one package at a time" pattern. The
 *     resolution caller indexes the returned array by `package`
 *     itself. Single network call per render (with cache, often zero).
 *
 *   - Return type is `readonly GadgetDescriptor[]` — the same shape the
 *     wire render-time resolution + downstream consumers (boilerplate
 *     generator, CSP builder, Permissions-Policy deriver, system
 *     prompt builder) already speak.
 *
 *   - Errors propagate. Adapters MUST throw on retrieval failure
 *     rather than returning an empty array — silent "no gadgets"
 *     would let renders through with broken gadget refs and surface
 *     as render-time hook-resolution failures. The caller's job is
 *     to decide whether the render fails (gate fires) or proceeds
 *     ungated.
 *
 * ## Deployment-specific adapters
 *
 * Per-deployment adapters wear this same interface: a JSON-backed
 * adapter reads from the `ggui.json#app.gadgets` array; a
 * database-backed adapter reads from an app-metadata store. Both
 * implement `GadgetCatalogAdapter`, so the enrichment pipeline doesn't
 * care which environment is feeding it.
 */

import type { GadgetDescriptor } from '@ggui-ai/protocol';

/**
 * Per-deployment source of registered gadget descriptors.
 *
 * Named parties: caller (render-time resolution / dev tools) ↔ adapter
 * (deployment-specific descriptor backing store, e.g., JSON, a
 * database, in-memory).
 *
 * Obligations:
 *   - `list(appId)` MUST return the full set of descriptors registered
 *     for `appId` in a single call. No pagination at this layer;
 *     adapters that page internally MUST aggregate before returning.
 *   - On retrieval failure, the adapter MUST throw — silently
 *     returning `[]` is forbidden (it would mask broken catalogs).
 *
 * Failure mode: thrown error propagates to caller. Caller decides
 * whether to fail the render (strict) or fall back to a default set
 * (lenient).
 *
 * Observable violation: caller observes a thrown error or a
 * descriptor-list whose contents are inconsistent with `appId`.
 */
export interface GadgetCatalogAdapter {
  /**
   * Resolve the full registered gadget catalog for a given app.
   *
   * Single-batch by design. Callers MUST NOT call this in a loop
   * per-package; index the returned array by `entry.package` instead.
   */
  list(appId: string): Promise<readonly GadgetDescriptor[]>;
}

/**
 * Static map-backed adapter. Pre-populated at construction; never
 * fetches anything at runtime. Right for tests, examples, and
 * deployments whose catalog is known at boot.
 */
export class InMemoryGadgetCatalog implements GadgetCatalogAdapter {
  readonly #byApp: ReadonlyMap<string, readonly GadgetDescriptor[]>;

  constructor(byApp: ReadonlyMap<string, readonly GadgetDescriptor[]>) {
    this.#byApp = byApp;
  }

  /**
   * Convenience factory for the common "every app gets the same
   * catalog" case (the OSS stdlib seed pattern). Apps not explicitly
   * keyed fall back to the supplied default.
   */
  static withDefault(
    defaultEntries: readonly GadgetDescriptor[],
    perApp?: ReadonlyMap<string, readonly GadgetDescriptor[]>,
  ): InMemoryGadgetCatalog {
    const merged = new Map<string, readonly GadgetDescriptor[]>();
    if (perApp) {
      for (const [appId, entries] of perApp) merged.set(appId, entries);
    }
    return new InMemoryGadgetCatalogWithFallback(merged, defaultEntries);
  }

  async list(appId: string): Promise<readonly GadgetDescriptor[]> {
    return this.#byApp.get(appId) ?? [];
  }
}

/**
 * `InMemoryGadgetCatalog` variant with a fallback for unknown app
 * IDs. Kept as a separate class so the base type's `list()` semantics
 * stay obvious (unknown app ⇒ empty list); the with-default variant
 * is opt-in via the factory.
 */
class InMemoryGadgetCatalogWithFallback extends InMemoryGadgetCatalog {
  readonly #fallback: readonly GadgetDescriptor[];

  constructor(
    byApp: ReadonlyMap<string, readonly GadgetDescriptor[]>,
    fallback: readonly GadgetDescriptor[],
  ) {
    super(byApp);
    this.#fallback = fallback;
  }

  override async list(appId: string): Promise<readonly GadgetDescriptor[]> {
    const direct = await super.list(appId);
    return direct.length > 0 ? direct : this.#fallback;
  }
}

/**
 * Decorator adapter — wraps any {@link GadgetCatalogAdapter} with
 * per-appId TTL caching + single-flight deduplication. Right for
 * production paths where the inner adapter hits a database / a
 * registry service and per-render fetches would dominate latency.
 *
 * Concurrent `list(appId)` calls during a cache miss share ONE
 * inflight Promise — no thundering herd against the inner adapter.
 *
 * Caches are scoped per-appId; entry TTL is configurable
 * (default 30s — short enough that operator changes propagate
 * promptly, long enough to amortize cold-start). Set `ttlMs: 0` for
 * single-flight-only behavior (no TTL caching, just dedup).
 */
export interface CachingGadgetCatalogOptions {
  /**
   * Per-entry time-to-live in milliseconds. Cache entries older than
   * this are refetched on next `list()`. `0` disables TTL caching
   * entirely (single-flight dedup only).
   *
   * Default: 30000 (30s).
   */
  readonly ttlMs?: number;
  /**
   * Clock injection for tests. Default `Date.now`.
   */
  readonly now?: () => number;
}

interface CacheEntry {
  readonly entries: readonly GadgetDescriptor[];
  readonly expiresAt: number; // monotonic ms; Infinity = never
}

export class CachingGadgetCatalog implements GadgetCatalogAdapter {
  readonly #inner: GadgetCatalogAdapter;
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<readonly GadgetDescriptor[]>>();

  constructor(
    inner: GadgetCatalogAdapter,
    options: CachingGadgetCatalogOptions = {},
  ) {
    this.#inner = inner;
    this.#ttlMs = options.ttlMs ?? 30_000;
    this.#now = options.now ?? Date.now;
  }

  async list(appId: string): Promise<readonly GadgetDescriptor[]> {
    const now = this.#now();
    const cached = this.#cache.get(appId);
    if (cached !== undefined && cached.expiresAt > now) {
      return cached.entries;
    }

    // Single-flight: if another caller is already fetching, share
    // their promise rather than firing a duplicate request.
    const inflight = this.#inflight.get(appId);
    if (inflight !== undefined) return inflight;

    const fetchPromise = (async (): Promise<readonly GadgetDescriptor[]> => {
      try {
        const entries = await this.#inner.list(appId);
        if (this.#ttlMs > 0) {
          this.#cache.set(appId, {
            entries,
            expiresAt: this.#now() + this.#ttlMs,
          });
        }
        return entries;
      } finally {
        this.#inflight.delete(appId);
      }
    })();

    this.#inflight.set(appId, fetchPromise);
    return fetchPromise;
  }

  /**
   * Drop the cached entry for `appId`. Right for operator-triggered
   * invalidation (gadget registered / unregistered / updated). When
   * `appId` is omitted, drops every cached entry.
   */
  invalidate(appId?: string): void {
    if (appId === undefined) {
      this.#cache.clear();
      return;
    }
    this.#cache.delete(appId);
  }
}
