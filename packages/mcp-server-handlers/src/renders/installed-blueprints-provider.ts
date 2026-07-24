/**
 * `InstalledBlueprintsProvider`.
 *
 * Bridges marketplace-installed blueprints into the unified matcher
 * pool at first-match time (lazy), without pulling esbuild into
 * `mcp-server-handlers`. Composition is by callback injection: the
 * caller (typically `@ggui-ai/dev-stack` + the CLI's `ggui serve`
 * composition layer) supplies the discovery + compile callbacks; the
 * provider orchestrates the install-to-cache walk and tracks
 * per-scope idempotency so subsequent `ensureCached` calls are cheap.
 *
 * ## Why lazy
 *
 * Boot-time compile of every installed blueprint would punish startup
 * latency proportional to the install count — a 10-blueprint
 * `.ggui/installed-blueprints` would burn ~1–2s of esbuild before the
 * first MCP tool can respond. Lazy + idempotent gives the same
 * steady-state cache density without the boot cost: the first
 * matchBlueprint call per scope pays the compile, every subsequent
 * call hits the cache directly.
 *
 * ## What about Tier-2 semantic-strategy queries
 *
 * The default ensureCached pre-caches ALL installed blueprints for
 * the scope on first call. This makes semantic-strategy queries see
 * the installed-blueprint embeddings in their RAG candidate pool.
 * The optional `contractKey` filter on `ensureCached` is a future
 * Tier-1-only optimization (compile just the matching one) but is
 * not exercised today — when an exact-key match runs, the matcher
 * still benefits because the relevant install is compiled in the
 * "compile all" pass.
 *
 * ## Compile-failure posture
 *
 * A broken installed blueprint (TSX syntax error, missing import,
 * etc.) MUST NOT break the match flow. The provider catches per-entry
 * compile failures, optionally surfaces them via `onIssue`, and
 * moves on. The scope is still marked "ensured" so we don't retry
 * the broken entry on every subsequent match — operators see the
 * issue once via the optional callback, then need to fix + restart.
 *
 * ## What this module does NOT do
 *
 * - **Discover installed blueprints.** That's `discoverLocalUis` in
 *   `@ggui-ai/project-config` + the `.ggui/installed-blueprints` glob
 *   constant from `@ggui-ai/cli`. The caller hands the result to
 *   the `installedBlueprints` callback.
 * - **Compile TSX.** That's `compileUiOnDemand` in `@ggui-ai/dev-stack`.
 *   The caller hands a wrapping function to the `compile` callback.
 * - **Watch the filesystem.** Re-install while running was handled
 *   in 2026-05-23 by switching the per-scope idempotency from
 *   "ensured: true forever" to "ensured under signature S until
 *   the discovered entry set hashes to a different signature".
 *   ensureCached now ALWAYS invokes the installedBlueprints
 *   callback (cheap — one DDB Query in the cloud bridge, one
 *   directory walk in OSS dev-stack); the compile sweep is the
 *   expensive part and IS still skipped on signature match. Orphan
 *   eviction at the end of the walk drops bridge-owned
 *   (`installed: true`) rows whose contractKey isn't in the current
 *   entry set — closes the G4 stale-cache leak (uninstall → next
 *   handshake → cache hit).
 */
import { createHash } from 'node:crypto';
import type { EnumerableVectorStore } from '@ggui-ai/mcp-server-core';
import {
  installToCache,
  type InstallToCacheInput,
} from './install-to-cache.js';
import {
  composeExactKey,
  deleteBlueprint,
  findBlueprintExact,
  listBlueprints,
  type BlueprintRegistryDeps,
} from './blueprint-registry.js';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';

/**
 * Default per-entry compile timeout. 30s is generous for esbuild —
 * typical single-screen UIs compile in 50–200ms; the cap defends
 * against a hung native binary or a pathological source.
 */
const DEFAULT_COMPILE_TIMEOUT_MS = 30_000;

/**
 * Race `p` against a timeout. On timeout, the returned promise rejects
 * with a clear `Error("<label> timed out after <ms>ms")`. The original
 * promise keeps running in the background — Node can't cancel a
 * pending Promise. The provider catches the rejection and routes it to
 * the `compile-threw` issue path so stale-row eviction still fires.
 */
function raceWithTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const t = setTimeout(() => {
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
      // Unref so a hung compile doesn't keep Node alive on shutdown.
      if (typeof t.unref === 'function') t.unref();
    }),
  ]);
}

/**
 * Minimal subset of a discovered installed-blueprint manifest that
 * the provider needs. Defined here (not imported from project-config /
 * dev-stack) so the handlers package doesn't gain a new dep — the
 * caller projects their richer discovered-UI shape down to this.
 */
export interface InstalledBlueprintEntry {
  /**
   * The synthetic manifest id (e.g. `vendor:counter:1.0.0`). Used
   * for issue reporting + idempotency keys when contractKey isn't
   * yet known.
   */
  readonly id: string;
  /** Absolute path to the `ggui.ui.json` for this installed blueprint. */
  readonly manifestPath: string;
  /**
   * The contract this blueprint serves. The matcher hashes this to
   * the same canonical key the agent would supply on handshake, so a
   * matching agent request will hit Tier 1 after this row lands in
   * the cache. If the manifest has no contract the caller filters
   * the entry out upstream — the provider only sees contract-bearing
   * entries.
   */
  readonly contract: InstallToCacheInput['contract'];
  /**
   * Intent prose for RAG embedding. Caller derives from the manifest
   * (typically `description ?? name`). Used by Tier-2 semantic
   * matching; Tier-1 exact-key matching ignores it.
   */
  readonly intent: string;
}

/**
 * Outcome of a per-entry compile + cache attempt. The provider surfaces
 * this via the optional `onIssue` callback (only for failures); callers
 * route issues to operator logs / dev-stack issue surfaces.
 */
export interface InstalledBlueprintCacheIssue {
  readonly id: string;
  readonly manifestPath: string;
  readonly kind:
    | 'compile-failed'
    | 'register-failed'
    | 'compile-threw'
    | 'stale-row-evicted';
  readonly message: string;
}

/**
 * Result of the compile callback. Mirrors `@ggui-ai/dev-stack`'s
 * `CompileResult` discriminated union shape but defined here so the
 * provider doesn't depend on dev-stack. Callers wrap their compile
 * function to produce this shape.
 */
export type CompileResult =
  | { kind: 'ok'; code: string }
  | { kind: 'missing-entry'; tried: readonly string[] }
  | { kind: 'failure'; errors: readonly string[] };

export interface CreateInstalledBlueprintsProviderOptions {
  /**
   * Yields the currently-discovered installed blueprints for the
   * scope. Called lazily on first ensureCached per scope. Returning
   * an empty array is fine — the provider records "ensured" and
   * returns immediately.
   */
  readonly installedBlueprints: (
    scope: string,
  ) => Promise<readonly InstalledBlueprintEntry[]> | readonly InstalledBlueprintEntry[];
  /**
   * Compile callback. The provider invokes this per installed
   * blueprint to turn the on-disk TSX into the componentCode string
   * the cache row carries.
   */
  readonly compile: (entry: InstalledBlueprintEntry) => Promise<CompileResult>;
  /**
   * Registry deps the provider uses to write installed entries into
   * the same vector store the matcher reads.
   */
  readonly deps: BlueprintRegistryDeps;
  /**
   * Optional issue callback — fires once per installed blueprint that
   * failed to compile or register. The provider already marks the
   * scope "ensured" regardless of issues, so this is the operator's
   * only signal that an entry didn't land.
   */
  readonly onIssue?: (issue: InstalledBlueprintCacheIssue) => void;
  /**
   * Per-entry compile timeout in milliseconds. esbuild is generally
   * bounded but a pathological source (or a hung native binary)
   * shouldn't sink an entire ensureCached walk. Default 30000ms
   * (30s). A timeout surfaces as `kind: 'compile-threw'` with a
   * clear message and triggers the stale-row eviction path.
   */
  readonly compileTimeoutMs?: number;
}

/**
 * Public surface — handed to `MatchBlueprintDeps.installedBlueprints`.
 */
export interface InstalledBlueprintsProvider {
  /**
   * Ensure all installed blueprints for `scope` are present in the
   * cache. Idempotent within a signature: every call re-reads the
   * installed list (cheap — typically one DDB Query) and skips the
   * compile/install walk when the signature matches the previous
   * walk. Signature change (install OR uninstall) triggers:
   *   - re-walk: compile + register every CURRENT entry (no-op for
   *     unchanged entries thanks to the underlying installToCache
   *     idempotency)
   *   - **orphan eviction**: any bridge-owned (`installed: true`)
   *     cache row at this scope whose contractKey isn't in the
   *     current entry set is deleted. Without this, uninstalled
   *     blueprints continue serving cache hits on handshake — the
   *     G4 stale-cache leak.
   *
   * Concurrent calls for the same scope share one ensure-walk via a
   * per-scope promise.
   */
  ensureCached(scope: string, options?: { contractKey?: string }): Promise<void>;
  /**
   * Explicit invalidation hook. Drops the signature-cache entry for
   * `scope` so the next `ensureCached` re-walks unconditionally
   * (even if the discovered entry list happens to hash identically
   * to the previous walk — e.g. when the caller has out-of-band
   * knowledge that the cache rows themselves drifted).
   *
   * Idempotent — invalidating a scope that's never been ensured is
   * a no-op. Does NOT itself evict cache rows; the next
   * `ensureCached` does that.
   */
  invalidate(scope: string): void;
  /**
   * Reference-equality handle on the provider's
   * `BlueprintRegistryDeps`. Exposed so consumers like
   * `createGguiServer` can verify the provider is wired to the SAME
   * `vectorStore` + `embedding` the matcher will read. Silent drift
   * between bridge writes and matcher reads would break the
   * install-to-cache invariant — without this hook the contract is
   * documented but unenforced.
   *
   * Do NOT replace the references; this is for sanity checks only.
   */
  readonly deps: BlueprintRegistryDeps;
}

/**
 * Stable hash of the installed-entry list. Folds in id + contractKey
 * for each entry, sorted so callback ordering jitter doesn't cause a
 * false-positive signature change. Intent is omitted — descriptive
 * prose churn shouldn't trigger a re-walk.
 *
 * Failure to compute a contractKey (malformed contract) skips that
 * entry in the signature so a transient discovery hiccup doesn't
 * mask a real change in the rest of the set.
 */
function computeSignature(
  entries: readonly InstalledBlueprintEntry[],
): string {
  const parts: string[] = [];
  for (const e of entries) {
    let key: string;
    try {
      key = blueprintKey(e.contract);
    } catch {
      continue;
    }
    parts.push(`${e.id} ${key}`);
  }
  parts.sort();
  return createHash('sha256').update(parts.join('')).digest('hex');
}

/**
 * Construct an {@link InstalledBlueprintsProvider}. Stateful in the
 * sense that it tracks "last ensured signature" per scope — caller
 * keeps a single instance per server lifetime.
 */
export function createInstalledBlueprintsProvider(
  options: CreateInstalledBlueprintsProviderOptions,
): InstalledBlueprintsProvider {
  // Per-scope state. `signature` is the hash of the last
  // successfully-walked entry set; `state` is either an in-flight
  // walk promise (concurrent callers share it) or `true` when the
  // walk has settled. A signature mismatch on the next ensureCached
  // call drops the entry + triggers a fresh walk with eviction.
  //
  // `discoveryPoisoned: true` is the sentinel for "the installed-
  // blueprints callback threw last time; don't retry it" (mirrors
  // the original `ensured=true` posture for discovery failures —
  // the operator restarts after fixing). Discovery-poisoned scopes
  // also short-circuit the signature-recompute path so the throwing
  // callback isn't invoked on every handshake.
  interface ScopeState {
    readonly signature: string;
    readonly state: Promise<void> | true;
    readonly discoveryPoisoned?: boolean;
  }
  const ensured = new Map<string, ScopeState>();

  // Bindings THIS provider instance registered, per scope:
  // contractKey → the exact index key + row id it bound. The walk's
  // orphan eviction sweeps the backing store's enumeration — but a
  // replica whose enumeration lags a peer's delete (eventually-
  // consistent listings) would keep serving Tier-1 hits from its own
  // process-local index binding, which no enumeration-based sweep can
  // see. Remembering what we bound lets the walk unbind by exact key
  // and delete the row by id — no enumeration involved, so listing
  // lag can't resurrect a hit on this instance. Per-process by
  // design: each instance cleans the index it writes to.
  const registeredBindings = new Map<
    string,
    Map<string, { readonly exactKey: string; readonly id: string }>
  >();

  async function walkScope(
    scope: string,
    entries: readonly InstalledBlueprintEntry[],
  ): Promise<void> {
    const compileTimeoutMs = options.compileTimeoutMs ?? DEFAULT_COMPILE_TIMEOUT_MS;
    for (const entry of entries) {
      let compileResult: CompileResult;
      try {
        compileResult = await raceWithTimeout(
          options.compile(entry),
          compileTimeoutMs,
          `compile for ${entry.id}`,
        );
      } catch (err) {
        options.onIssue?.({
          id: entry.id,
          manifestPath: entry.manifestPath,
          kind: 'compile-threw',
          message: err instanceof Error ? err.message : String(err),
        });
        await evictStaleInstallRow(options.deps, scope, entry, options.onIssue);
        continue;
      }

      if (compileResult.kind === 'missing-entry') {
        options.onIssue?.({
          id: entry.id,
          manifestPath: entry.manifestPath,
          kind: 'compile-failed',
          message: `entry file missing — tried ${compileResult.tried.join(', ')}`,
        });
        await evictStaleInstallRow(options.deps, scope, entry, options.onIssue);
        continue;
      }
      if (compileResult.kind === 'failure') {
        options.onIssue?.({
          id: entry.id,
          manifestPath: entry.manifestPath,
          kind: 'compile-failed',
          message: compileResult.errors.join('; '),
        });
        await evictStaleInstallRow(options.deps, scope, entry, options.onIssue);
        continue;
      }

      try {
        const registered = await installToCache(options.deps, scope, {
          contract: entry.contract,
          componentCode: compileResult.code,
          intent: entry.intent,
        });
        let bucket = registeredBindings.get(scope);
        if (!bucket) {
          bucket = new Map();
          registeredBindings.set(scope, bucket);
        }
        bucket.set(registered.contractKey, {
          exactKey: composeExactKey(
            registered.kind,
            registered.contractKey,
            registered.variantKey,
          ),
          id: registered.id,
        });
      } catch (err) {
        options.onIssue?.({
          id: entry.id,
          manifestPath: entry.manifestPath,
          kind: 'register-failed',
          message: err instanceof Error ? err.message : String(err),
        });
        await evictStaleInstallRow(options.deps, scope, entry, options.onIssue);
      }
    }

    // Orphan eviction: drop bridge-owned (`installed: true`) rows
    // whose contractKey is NOT in the current entry set. Covers the
    // G4 uninstall path — when an entry disappears between walks, its
    // installed cache row would otherwise serve hits forever. Rows the
    // bridge does not own (cold-gen `llm` rows, operator-registered
    // rows) survive untouched — eviction keys on the lifecycle
    // marker, never on authorship.
    //
    const liveKeys = new Set<string>();
    for (const entry of entries) {
      try {
        liveKeys.add(blueprintKey(entry.contract));
      } catch {
        // Malformed contract — already surfaced as an issue during
        // walk; skip from the live-set so it doesn't accidentally
        // mask an orphan elsewhere.
      }
    }

    // Local binding sweep FIRST — unbind rows THIS instance
    // registered whose contractKey left the discovered set, by
    // remembered exact key + id. Runs before (and independent of)
    // the enumeration-based scan below: it needs no enumeration, so
    // it works on non-enumerable backends AND is immune to a lagging
    // listing hiding a peer-deleted row. Without it, a Tier-1 index
    // hit on this instance keeps re-validating against the lagging
    // listing and serves the uninstalled blueprint until the lag
    // clears (G4 pod-matcher failure, run 30072993411).
    const bucket = registeredBindings.get(scope);
    if (bucket) {
      for (const [cKey, binding] of bucket) {
        if (liveKeys.has(cKey)) continue;
        try {
          await options.deps.index.deleteId(scope, binding.exactKey);
        } catch {
          // Best-effort — a surviving binding self-heals only once
          // the backing listing catches up; the issue line below
          // still surfaces the attempt.
        }
        try {
          await options.deps.vectorStore.deleteVector(scope, binding.id);
        } catch {
          // Best-effort — the enumeration-based scan retries when
          // the row is visible.
        }
        bucket.delete(cKey);
        options.onIssue?.({
          id: binding.id,
          manifestPath: scope,
          kind: 'stale-row-evicted',
          message:
            `unbound locally-registered row (contractKey=${cKey}) — ` +
            'entry no longer in the discovered set; caller likely uninstalled it',
        });
      }
      if (bucket.size === 0) registeredBindings.delete(scope);
    }

    // listByScope is a single enumeration call (S3VectorsStorage,
    // sqlite, in-memory all support it). Skip eviction when the
    // backend isn't enumerable rather than fail — non-enumerable
    // backends are rare (legacy hosted before Opt-B) and the symptom
    // gracefully degrades to the pre-fix state for them.
    const store = options.deps.vectorStore;
    if (!('listByScope' in store) || typeof store.listByScope !== 'function') {
      return;
    }
    let cached: ReadonlyArray<{
      readonly id: string;
      readonly installed?: boolean;
      readonly contractKey?: string;
    }>;
    try {
      cached = await listBlueprints(
        { vectorStore: store as EnumerableVectorStore },
        scope,
      );
    } catch (err) {
      options.onIssue?.({
        id: '<orphan-scan>',
        manifestPath: scope,
        kind: 'compile-threw',
        message: `orphan eviction listByScope failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      return;
    }
    for (const row of cached) {
      if (row.installed !== true) continue;
      const key = row.contractKey;
      if (key !== undefined && liveKeys.has(key)) continue;
      // Orphan. Either we couldn't read the row's contractKey or it's
      // not in the live set — either way it shouldn't be served.
      try {
        await deleteBlueprint(
          { vectorStore: store, index: options.deps.index },
          scope,
          row.id,
        );
        options.onIssue?.({
          id: row.id,
          manifestPath: scope,
          kind: 'stale-row-evicted',
          message: `evicted orphan installed row (contractKey=${
            key ?? '<unknown>'
          }) — entry no longer in the discovered set; caller likely uninstalled it`,
        });
      } catch {
        // Best-effort — orphan survives if the store rejects the
        // delete. Operator still sees the issue list above.
      }
    }
  }

  return {
    async ensureCached(scope) {
      const prior = ensured.get(scope);

      // Discovery-poisoned scopes short-circuit before re-invoking
      // the throwing callback. Operator restarts the pod after
      // fixing whatever made discovery throw.
      if (prior?.discoveryPoisoned) return;

      // If a walk is currently in flight for this scope, share it.
      // Concurrent callers await the same discovery + compile sweep
      // rather than each spawning their own.
      if (prior && prior.state !== true) {
        await prior.state;
        return;
      }

      // Start a new ensure cycle. Invoke discovery + signature
      // computation + (conditional) walk inside a single shared
      // promise so subsequent concurrent callers latch onto it.
      const work = (async () => {
        let entries: readonly InstalledBlueprintEntry[];
        try {
          entries = await options.installedBlueprints(scope);
        } catch (err) {
          options.onIssue?.({
            id: '<discovery>',
            manifestPath: scope,
            kind: 'compile-threw',
            message: `installed-blueprint discovery threw: ${
              err instanceof Error ? err.message : String(err)
            }`,
          });
          ensured.set(scope, {
            signature: '<discovery-error>',
            state: true,
            discoveryPoisoned: true,
          });
          return;
        }
        const signature = computeSignature(entries);
        if (prior && prior.signature === signature) {
          // Nothing changed since last walk — just mark ensured
          // under the same sig + skip the compile sweep.
          ensured.set(scope, { signature, state: true });
          return;
        }
        try {
          await walkScope(scope, entries);
        } catch {
          // walkScope's per-entry catches mean reaching here means
          // the orphan-scan or listByScope step itself threw; mark
          // ensured under the new signature anyway so we don't
          // re-throw on every handshake.
        }
        ensured.set(scope, { signature, state: true });
      })();

      // Register the in-flight promise under whatever signature we
      // currently know (the prior one if any, else a placeholder).
      // Concurrent callers see `state !== true` and latch on. The
      // promise body overwrites with the real signature when settled.
      ensured.set(scope, {
        signature: prior?.signature ?? '<pending>',
        state: work,
      });
      await work;
    },
    invalidate(scope) {
      ensured.delete(scope);
    },
    deps: options.deps,
  };
}

/**
 * When an installed blueprint fails the current boot's compile (or
 * register), evict any prior bridge-owned (`installed: true`) row at
 * the same canonical contractKey from the cache. Without this,
 * persistent vectorStore backends (sqlite, a cloud datastore) would
 * continue serving the previous boot's componentCode — drift between
 * the installed source on disk and the cached output matters more
 * than the matcher's "best-effort" no-write posture.
 *
 * Eviction is precise: we only delete rows the bridge owns (the
 * `installed` lifecycle marker). Rows minted by other writers at the
 * same contractKey (legitimate cold-gen products from a different
 * lifecycle) survive untouched. Best-effort: a lookup or delete
 * failure swallows; the worst case is "stale row survives" which is
 * the pre-fix state.
 */
async function evictStaleInstallRow(
  deps: BlueprintRegistryDeps,
  scope: string,
  entry: InstalledBlueprintEntry,
  onIssue: CreateInstalledBlueprintsProviderOptions['onIssue'],
): Promise<void> {
  let contractKey: string;
  try {
    contractKey = blueprintKey(entry.contract);
  } catch {
    return;
  }
  let existing;
  try {
    existing = await findBlueprintExact(
      { vectorStore: deps.vectorStore, index: deps.index },
      scope,
      'template',
      contractKey,
    );
  } catch {
    return;
  }
  if (!existing || existing.installed !== true) return;
  try {
    await deleteBlueprint(
      { vectorStore: deps.vectorStore, index: deps.index },
      scope,
      existing.id,
    );
    onIssue?.({
      id: entry.id,
      manifestPath: entry.manifestPath,
      kind: 'stale-row-evicted',
      message: `evicted previously-cached installed row (contractKey=${contractKey}) because the current boot's compile/register failed; the matcher will fall through to cold-gen until the operator fixes the on-disk source`,
    });
  } catch {
    // Best-effort — stale row survives if the store rejects the
    // delete. Operator still sees the compile/register issue above.
  }
}
