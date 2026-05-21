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
 * - **Watch the filesystem.** Re-install while running requires a
 *   refresh — see `LocalUiRegistry.subscribe()` semantics. A
 *   follow-up could invalidate the per-scope idempotency tracker on
 *   detected change.
 */
import {
  installToCache,
  type InstallToCacheInput,
} from './install-to-cache.js';
import {
  composeBlueprintId,
  deleteBlueprint,
  findBlueprintExact,
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
   * cache. Idempotent: a per-scope flag prevents re-walks. Concurrent
   * calls for the same scope share one ensure-walk via a per-scope
   * promise.
   */
  ensureCached(scope: string, options?: { contractKey?: string }): Promise<void>;
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
 * Construct an {@link InstalledBlueprintsProvider}. Stateful in the
 * sense that it tracks "already ensured" scopes — caller keeps a
 * single instance per server lifetime.
 */
export function createInstalledBlueprintsProvider(
  options: CreateInstalledBlueprintsProviderOptions,
): InstalledBlueprintsProvider {
  // Per-scope state: undefined = never seen; Promise = walk in
  // flight; true = walk complete (success or quenched). Sharing the
  // promise across concurrent callers makes ensureCached a single
  // bounded compile sweep per scope, even under burst load.
  const ensured = new Map<string, Promise<void> | true>();

  async function walkScope(scope: string): Promise<void> {
    let entries: readonly InstalledBlueprintEntry[];
    try {
      entries = await options.installedBlueprints(scope);
    } catch (err) {
      // Discovery failure: surface as a scope-level issue and mark
      // ensured (don't retry — the operator either fixes the issue
      // and restarts, or accepts no installed-blueprint cache).
      options.onIssue?.({
        id: '<discovery>',
        manifestPath: scope,
        kind: 'compile-threw',
        message: `installed-blueprint discovery threw: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      return;
    }

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
        await installToCache(options.deps, scope, {
          contract: entry.contract,
          componentCode: compileResult.code,
          intent: entry.intent,
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
  }

  return {
    async ensureCached(scope) {
      const existing = ensured.get(scope);
      if (existing === true) return;
      if (existing) {
        await existing;
        return;
      }
      const work = walkScope(scope).then(
        () => {
          ensured.set(scope, true);
        },
        // walkScope never rejects — it catches per-entry. Defensive:
        // if the contract drifts and walkScope somehow throws, mark
        // ensured anyway so we don't retry forever.
        () => {
          ensured.set(scope, true);
        },
      );
      ensured.set(scope, work);
      await work;
    },
    deps: options.deps,
  };
}

/**
 * When an installed blueprint fails the current boot's compile (or
 * register), evict any prior `provenance: 'install'` row at the same
 * canonical contractKey from the cache. Without this, persistent
 * vectorStore backends (sqlite, a cloud datastore) would continue
 * serving the previous boot's componentCode — drift between the
 * installed source on disk and the cached output matters more than
 * the matcher's "best-effort" no-write posture.
 *
 * Eviction is precise: we only delete rows whose `provenance` is
 * `'install'`. Synth-provenance rows at the same contractKey
 * (legitimate cold-gen products from a different lifecycle) survive
 * untouched. Best-effort: a lookup or delete failure swallows; the
 * worst case is "stale row survives" which is the pre-fix state.
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
      { vectorStore: deps.vectorStore },
      scope,
      'template',
      contractKey,
    );
  } catch {
    return;
  }
  if (!existing || existing.provenance !== 'install') return;
  try {
    await deleteBlueprint(
      { vectorStore: deps.vectorStore },
      scope,
      composeBlueprintId('template', contractKey),
    );
    onIssue?.({
      id: entry.id,
      manifestPath: entry.manifestPath,
      kind: 'stale-row-evicted',
      message: `evicted previously-cached install-provenance row (contractKey=${contractKey}) because the current boot's compile/register failed; the matcher will fall through to cold-gen until the operator fixes the on-disk source`,
    });
  } catch {
    // Best-effort — stale row survives if the store rejects the
    // delete. Operator still sees the compile/register issue above.
  }
}
