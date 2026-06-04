/**
 * `installToCache` — the bridge from marketplace-installed
 * blueprints to the unified matcher pool.
 *
 * The `matchBlueprint` matcher reads the runtime cache, which is fed
 * by three writers:
 *
 *   1. `ggui_render` cold-gen — synth-time, `provenance: 'synth'`.
 *   2. `ggui_ops_blueprint_register` / `_generate` — operator hand-
 *      writes a blueprint, `provenance: 'register'`.
 *   3. This bridge — marketplace-installed blueprints,
 *      `provenance: 'install'`.
 *
 * Marketplace-installed blueprints are materialized to disk by
 * `ggui blueprint install` under `.ggui/installed-blueprints/...`.
 * Without this bridge they would be a separate browsing surface the
 * matcher never sees — installing a blueprint would NOT accelerate
 * the next handshake/render. The bridge lands the install in the same
 * `vectorStore` the matcher already reads, tagged
 * `provenance: 'install'` so operator surfaces stay debuggable.
 * Matcher logic is unchanged — it never inspects provenance.
 *
 * ## Why a named bridge instead of a direct `registerBlueprint` call
 *
 *   1. **Provenance pinning.** Callers can't accidentally tag an
 *      install with `'synth'`. The bridge forces `'install'`.
 *   2. **Grep target.** "How do installed blueprints reach the
 *      cache?" → `installToCache` is the single answer. The cloud
 *      bridge mirrors the same name on the server side.
 *   3. **Future extension.** Install-specific concerns (signature
 *      re-verification on hot path, manifest staleness checks, dual-
 *      write to a per-app `provenance: 'install'` index) hook here
 *      without touching every synth/register call site.
 *
 * ## What this module does NOT do
 *
 *   - **TSX compilation.** Compile-on-demand (`esbuild`) lives in
 *     `@ggui-ai/dev-stack`'s `compile-ui.ts`. `mcp-server-handlers`
 *     intentionally stays free of bundler dependencies — the install
 *     wire-up at the dev-stack / mcp-server layer compiles first,
 *     then hands the resulting `componentCode` here. A cloud
 *     deployment does the equivalent inside its server runtime.
 *   - **Manifest discovery.** `discoverLocalUis` already walks
 *     `ggui.json#blueprints.include` globs and emits typed
 *     `DiscoveredUi` rows. The bridge consumes the contract +
 *     componentCode that the dev-stack wire-up extracts.
 */
import {
  registerBlueprint,
  type Blueprint,
  type BlueprintRegistryDeps,
  type RegisterBlueprintOptions,
} from './blueprint-registry.js';
import type { DataContract } from '@ggui-ai/protocol';

/**
 * Inputs for {@link installToCache}.
 *
 * The bridge writes exactly one `'template'` blueprint row. Other
 * atomic-design kinds (organism / molecule / atom) aren't on the
 * install path today; if a future compositional surface emits
 * smaller-grain installed blueprints, the bridge widens here.
 */
export interface InstallToCacheInput {
  /**
   * The canonicalized contract this blueprint serves. Comes from
   * `UiManifest.contract` — the marketplace artifact carries it
   * verbatim, so installed entries match the same canonical-key
   * shape the matcher hashes on Tier 1 lookup. If the manifest has
   * no contract, the install flow MUST skip the bridge — there's
   * nothing to match against.
   */
  readonly contract: DataContract;
  /**
   * Pre-compiled component bytecode. The dev-stack install wire-up
   * compiles the manifest's `index.tsx` via `compileUiOnDemand`
   * (esbuild, no LLM) and passes the result here. A cloud
   * deployment does the equivalent inside its server runtime. Empty
   * string is a caller bug — `registerBlueprint` accepts it but the
   * matcher hit would serve empty code, which we treat as a misuse
   * here.
   */
  readonly componentCode: string;
  /**
   * Intent prose used for RAG embedding. Derived by the caller from
   * the manifest — typically `manifest.description ?? scope/name`.
   * The matcher's exact-key strategy (which fires when the agent
   * supplies a contract on handshake) ignores intent; semantic
   * strategy uses it as one of the embedding inputs alongside
   * `summarizeContract(contract)`.
   */
  readonly intent: string;
}

/**
 * Bridge: install → cache. Writes a `'template'` blueprint into the
 * scope's vector store with `provenance: 'install'`.
 *
 * Idempotent on `(scope, contractKey)` — re-installing the same
 * `(scope, name, version)` triple produces the same canonical
 * contract → same `contractKey` → re-write of the existing row.
 * Hit counters reset on re-write (accepted; the operator explicitly
 * asked for a refresh).
 *
 * Best-effort posture: the caller decides whether a registry-write
 * failure is fatal. The install CLI surface treats it as non-fatal
 * (the on-disk install succeeded; the next handshake will
 * lazy-compile + retry). The cloud install path treats it as fatal
 * (the operator-visible mutation must observe the cache write).
 * The bridge itself raises on registry errors — wrappers like
 * `safelyRegisterBlueprint` add the swallow.
 *
 * Empty `componentCode` is rejected: an installed blueprint with no
 * code can't accelerate render and would serve a blank render on
 * cache hit. Callers MUST compile before invoking the bridge.
 *
 * Returns the registered blueprint, carrying the synthetic id +
 * canonical contract key the matcher will key on.
 */
export async function installToCache(
  deps: BlueprintRegistryDeps,
  scope: string,
  input: InstallToCacheInput,
  options: RegisterBlueprintOptions = {},
): Promise<Blueprint> {
  if (input.componentCode.length === 0) {
    throw new Error(
      'installToCache: componentCode is empty. Compile the installed ' +
        'blueprint TSX before invoking the bridge — a cache hit on empty ' +
        'code would serve a blank render.',
    );
  }
  return registerBlueprint(
    deps,
    scope,
    {
      kind: 'template',
      contract: input.contract,
      intent: input.intent,
      componentCode: input.componentCode,
      provenance: 'install',
    },
    options,
  );
}
