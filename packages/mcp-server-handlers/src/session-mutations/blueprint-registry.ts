/**
 * Blueprint registry.
 *
 * Storage layer for the blueprint-first runtime cache. Supersedes the
 * intent-keyed `generation-cache.ts` with a contract-keyed registry
 * that supports the three-tier match flow:
 *
 *   - Tier 1: exact contract-hash lookup → instant reuse.
 *   - Tier 2: RAG retrieval → top-K candidates handed to the LLM judge.
 *   - Tier 3: cold gen → register the produced blueprint.
 *
 * ## Storage layout (asset-keyed)
 *
 * Keys are synthetic: `${kind}:${contractKey}` where `kind` is the
 * atomic-design level (`'template'` for full components today;
 * `'organism'` / `'molecule'` / `'atom'` reserved for future
 * compositional decomposition). The `VectorStore` contract stays
 * unchanged — composition lives at the cache layer.
 *
 * One blueprint per `(scope, kind, contractKey)` tuple. Future
 * variant support (multiple visual treatments for the same contract
 * shape) would go through `${kind}:${contractKey}#${variantId}`
 * keys — deferred until cache eviction proves it necessary.
 *
 * ## What's stored
 *
 *   - vector: embedding of `summarizeContract(contract) + intent`
 *     (the same shape the LLM judge sees — no second source of truth).
 *   - metadata: a JSON blob carrying
 *     `{intent, contract, componentCode, contractKey, createdAt,
 *     hitCount, lastHitAt?}` so reconstruction is one round-trip.
 *
 * ## Pure-data layer
 *
 * No LLM calls in this module. The judge / rerank step happens
 * downstream in the handshake handler. Registry just persists,
 * retrieves, and enumerates.
 */
import type {
  EmbeddingProvider,
  EnumerableVectorStore,
  VectorEntry,
  VectorSearchResult,
  VectorStore,
} from '@ggui-ai/mcp-server-core';
import { summarizeContract, type DataContract } from '@ggui-ai/protocol';
// `blueprintKey` is server-only — pulled in from a dedicated subpath
// because it imports `node:crypto`, which browsers can't bundle.
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  validateContractStructure,
  type ContractValidationFinding,
  type ContractValidationResult,
} from '@ggui-ai/negotiator';

/**
 * Atomic-design level. The runtime currently writes only
 * `'template'` — the full-component case. Smaller-grain kinds are
 * reserved for future compositional decomposition.
 */
export type BlueprintKind = 'template' | 'organism' | 'molecule' | 'atom';

/**
 * How a blueprint entered the registry. This marker surfaces the
 * three distinct cache-write paths on the unified matcher pool —
 * same read surface, different lifecycles upstream.
 *
 *   - `'synth'`    — produced by `ggui_render` cold-gen + cached for reuse.
 *   - `'register'` — operator-written via the `ggui_ops_blueprint_*`
 *                    admin surface (hand-curated or imported).
 *   - `'install'`  — materialized from a marketplace artifact via
 *                    `ggui blueprint install` + compiled to bytecode
 *                    by the install bridge.
 *
 * Purely informational: the matcher ignores provenance and the field
 * never gates a hit. Surfaced on cache-list ops tooling so operators
 * can answer "which blueprints in this app came from the marketplace?"
 * without joining against external state.
 */
export type BlueprintProvenance = 'synth' | 'register' | 'install';

/** A blueprint as carried through the registry. */
export interface Blueprint {
  /** Synthetic registry id: `${kind}:${contractKey}`. */
  readonly id: string;
  readonly kind: BlueprintKind;
  /** Identity hash of `contract` — equal contract produce equal keys. */
  readonly contractKey: string;
  readonly contract: DataContract;
  /** Original intent prose that produced the blueprint. Diagnostic + RAG. */
  readonly intent: string;
  /** Generated component source. Empty string when generation hasn't happened yet. */
  readonly componentCode: string;
  /** ISO timestamp of registration. */
  readonly createdAt: string;
  /** Times this entry was returned as a registry hit. Bumps on Tier 1 + Tier 2 hits. */
  readonly hitCount: number;
  /** ISO timestamp of the most recent hit. Absent until first hit. */
  readonly lastHitAt?: string;
  /**
   * How this entry entered the registry. See {@link BlueprintProvenance}.
   * Rows written before the provenance field existed lack it;
   * {@link rowToBlueprint} defaults them to `'synth'` since the
   * cold-gen path was the only writer at that point — strictly
   * informational migration semantics, not a back-compat shim.
   */
  readonly provenance: BlueprintProvenance;
  /**
   * Structural validator findings emitted at registration time. Only
   * `severity: 'warn'` findings reach this list — `severity: 'error'`
   * findings short-circuit registration via {@link BlueprintRejectedError}.
   * Surfaced on the return value (NOT persisted in vector-store metadata)
   * so operators can see "this blueprint registered with warnings" without
   * widening the storage schema.
   */
  readonly validationWarnings?: readonly ContractValidationFinding[];
}

/**
 * Pluggable contract-validator. Defaults to {@link validateContractStructure}
 * from `@ggui-ai/negotiator`. Tests inject custom validators to assert
 * fail-closed semantics on `severity: 'error'` findings; production wires
 * the default and lets the heuristic decide.
 */
export type ContractValidator = (
  contract: DataContract,
) => ContractValidationResult;

/**
 * Thrown by {@link registerBlueprint} when the structural validator
 * emits one or more `severity: 'error'` findings. Carries the full
 * findings list so callers can render the diagnostic alongside the
 * rejected contract — e.g. on a cache trace event or in an operator
 * log line.
 *
 * Distinct from contract-shape and access errors thrown elsewhere:
 *   - ContractViolationError      — runtime data violates a declared schema
 *   - RenderNotFoundError         — target render id is missing
 *   - EventNotAllowedError        — event type not in the subscription allowlist
 *   - BlueprintRejectedError (this) — contract structure trips a fail-closed
 *                                     validator finding at registration time
 */
export class BlueprintRejectedError extends Error {
  readonly code = 'blueprint_rejected' as const;
  readonly findings: readonly ContractValidationFinding[];
  constructor(findings: readonly ContractValidationFinding[]) {
    const summary = findings.map((f) => `[${f.kind}] ${f.hint}`).join(' | ');
    super(
      `registerBlueprint: contract rejected by structural validator. ${summary}`,
    );
    this.name = 'BlueprintRejectedError';
    this.findings = findings;
  }
}

/** Compose deps for the registry — embedder + vector store. */
export interface BlueprintRegistryDeps {
  readonly embedding: EmbeddingProvider;
  readonly vectorStore: VectorStore;
}

/** Input for {@link registerBlueprint}. */
export interface RegisterBlueprintInput {
  readonly kind: BlueprintKind;
  readonly contract: DataContract;
  readonly intent: string;
  readonly componentCode: string;
  /**
   * How this blueprint entered the registry. Production callers
   * SHOULD pass this explicitly so admin/cache/list can distinguish
   * synth vs. operator-registered vs. marketplace-installed entries.
   * Defaults to `'synth'` because the cold-gen path was the original
   * (and once the only) writer; untagged rows pre-date the
   * multi-provenance model and are necessarily from synth. The
   * matcher ignores provenance; tagging is purely for observability.
   */
  readonly provenance?: BlueprintProvenance;
}

/**
 * Compose the synthetic registry id from kind + contractKey. Exposed
 * so consumers can build the same shape when they need to look up
 * by hand (devtools, tests, hand-curated seeds).
 */
export function composeBlueprintId(
  kind: BlueprintKind,
  contractKey: string,
): string {
  return `${kind}:${contractKey}`;
}

/**
 * Compute the embedding input string. Concatenates the canonical
 * contract summary with the intent prose so retrieval is hybrid:
 * structural shape anchors the result, intent prose feeds bge-small's
 * topic-similarity awareness.
 *
 * Exported so the rerank prompt path can produce the same string —
 * the prompt's `cachedContractSummary` MUST equal what was embedded.
 */
export function composeEmbeddingInput(
  contract: DataContract | undefined,
  intent: string,
): string {
  return `${summarizeContract(contract)}\nINTENT: ${intent.trim()}`;
}

const METADATA_KEYS = {
  intent: 'intent',
  componentCode: 'componentCode',
  contract: 'contract',
  contractKey: 'contractKey',
  kind: 'kind',
  createdAt: 'createdAt',
  hitCount: 'hitCount',
  lastHitAt: 'lastHitAt',
  provenance: 'provenance',
} as const;

function blueprintToMetadata(
  bp: Omit<Blueprint, 'id'>,
): Record<string, string | number | boolean | null> {
  return {
    [METADATA_KEYS.intent]: bp.intent,
    [METADATA_KEYS.componentCode]: bp.componentCode,
    [METADATA_KEYS.contract]: JSON.stringify(bp.contract),
    [METADATA_KEYS.contractKey]: bp.contractKey,
    [METADATA_KEYS.kind]: bp.kind,
    [METADATA_KEYS.createdAt]: bp.createdAt,
    [METADATA_KEYS.hitCount]: bp.hitCount,
    [METADATA_KEYS.provenance]: bp.provenance,
    ...(bp.lastHitAt !== undefined
      ? { [METADATA_KEYS.lastHitAt]: bp.lastHitAt }
      : {}),
  };
}

function readProvenance(
  value: string | number | boolean | null | undefined,
): BlueprintProvenance {
  // Rows written before the provenance field existed have no
  // `provenance` key in metadata. Default to 'synth' since the
  // cold-gen path was the only writer at the time — operator
  // surfaces label legacy entries accordingly. New writes always
  // carry the field per `RegisterBlueprintInput`.
  if (value === 'synth' || value === 'register' || value === 'install') {
    return value;
  }
  return 'synth';
}

function readScalarString(
  value: string | number | boolean | null | undefined,
): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function readScalarNumber(
  value: string | number | boolean | null | undefined,
): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

/**
 * Reconstruct a `Blueprint` from a vector store row. Returns `null`
 * when the row's shape doesn't match (defensive — same scope can
 * legitimately host other vector families today, and we silently
 * skip foreign rows rather than crashing on missing fields).
 */
function rowToBlueprint(
  key: string,
  metadata: Record<string, string | number | boolean | null>,
): Blueprint | null {
  const intent = readScalarString(metadata[METADATA_KEYS.intent]);
  const componentCode = readScalarString(metadata[METADATA_KEYS.componentCode]);
  const contractStr = readScalarString(metadata[METADATA_KEYS.contract]);
  const contractKey = readScalarString(metadata[METADATA_KEYS.contractKey]);
  const kindStr = readScalarString(metadata[METADATA_KEYS.kind]);
  const createdAt = readScalarString(metadata[METADATA_KEYS.createdAt]);
  if (
    intent === undefined ||
    componentCode === undefined ||
    contractStr === undefined ||
    contractKey === undefined ||
    kindStr === undefined ||
    createdAt === undefined
  ) {
    return null;
  }
  if (
    kindStr !== 'template' &&
    kindStr !== 'organism' &&
    kindStr !== 'molecule' &&
    kindStr !== 'atom'
  ) {
    return null;
  }
  let contract: DataContract;
  try {
    contract = JSON.parse(contractStr) as DataContract;
  } catch {
    return null;
  }
  const hitCount = readScalarNumber(metadata[METADATA_KEYS.hitCount]) ?? 0;
  const lastHitAt = readScalarString(metadata[METADATA_KEYS.lastHitAt]);
  const provenance = readProvenance(metadata[METADATA_KEYS.provenance]);
  return {
    id: key,
    kind: kindStr,
    contractKey,
    contract,
    intent,
    componentCode,
    createdAt,
    hitCount,
    provenance,
    ...(lastHitAt !== undefined ? { lastHitAt } : {}),
  };
}

/**
 * Default cap on registered blueprints per (scope, kind). When a
 * fresh registration would push the bucket past the cap,
 * {@link registerBlueprint} evicts the lowest-`hitCount` entry first;
 * ties broken by oldest `createdAt`. The number is calibrated for an
 * OSS single-tenant `ggui serve` workload — every push is one
 * `template` entry, so 100 templates per scope = ~100 distinct
 * UI shapes the agent has built in this session, well above any
 * realistic single-app surface and small enough to keep the
 * `InMemoryVectorStore` footprint bounded under abuse.
 */
export const DEFAULT_MAX_BLUEPRINTS_PER_KIND = 100;

export interface RegisterBlueprintOptions {
  /**
   * Cap on entries per (scope, kind). When the bucket already holds
   * `cap` entries AND the new key isn't a re-write of an existing
   * row, the lowest-hitCount entry is evicted before the put.
   * Re-writes (same key) bypass eviction — they don't grow the bucket.
   * Set to `Infinity` to disable eviction (test-only; production
   * paths should always cap to bound memory).
   */
  readonly maxPerKind?: number;
  /**
   * Override the default structural validator. Defaults to
   * {@link validateContractStructure} from `@ggui-ai/negotiator`. Tests
   * inject custom validators to exercise the fail-closed branch on
   * `severity: 'error'` findings (today's heuristic only emits warnings,
   * so the fail-closed branch never fires under the default validator).
   */
  readonly validator?: ContractValidator;
}

/**
 * Register a blueprint into the scope. Idempotent on key — re-
 * registering the same `(kind, contractKey)` overwrites the existing
 * entry's metadata and re-embeds (hit counters reset; that's
 * accepted because re-registration only happens on a fresh cold-gen
 * which means the underlying componentCode also changed).
 *
 * Validation: the contract is run through the structural validator
 * BEFORE any write. `severity: 'error'` findings short-circuit the
 * registration with {@link BlueprintRejectedError} — a bad shape never
 * enters the registry where future Tier 1/2 hits would re-serve it.
 * `severity: 'warn'` findings register normally but are surfaced on the
 * returned blueprint's `validationWarnings` so operators can see
 * "this entry had warnings at registration." Today's default validator
 * only emits warnings; the fail-closed branch is wired ahead of the
 * heuristic graduating findings to `'error'`.
 *
 * Eviction: when the (scope, kind) bucket is at capacity AND the new
 * key is NOT a re-write of an existing row, the lowest-hitCount entry
 * is deleted first. Ties break by oldest `createdAt`. Eviction needs an
 * `EnumerableVectorStore` to enumerate the bucket; non-enumerable
 * backends (e.g. hosted S3 Vectors) skip eviction — the hosted layer is
 * expected to manage its own GC.
 */
export async function registerBlueprint(
  deps: BlueprintRegistryDeps,
  scope: string,
  input: RegisterBlueprintInput,
  options: RegisterBlueprintOptions = {},
): Promise<Blueprint> {
  if (input.intent.trim().length === 0) {
    throw new Error('registerBlueprint: intent cannot be empty');
  }

  const validator = options.validator ?? validateContractStructure;
  const validation = validator(input.contract);
  const errorFindings = validation.findings.filter(
    (f) => f.severity === 'error',
  );
  if (errorFindings.length > 0) {
    throw new BlueprintRejectedError(errorFindings);
  }
  const warnFindings = validation.findings.filter(
    (f) => f.severity === 'warn',
  );

  const contractKey = blueprintKey(input.contract);
  const id = composeBlueprintId(input.kind, contractKey);
  const createdAt = new Date().toISOString();
  const blueprint: Blueprint = {
    id,
    kind: input.kind,
    contractKey,
    contract: input.contract,
    intent: input.intent.trim(),
    componentCode: input.componentCode,
    createdAt,
    hitCount: 0,
    provenance: input.provenance ?? 'synth',
    ...(warnFindings.length > 0
      ? { validationWarnings: warnFindings }
      : {}),
  };

  const cap = options.maxPerKind ?? DEFAULT_MAX_BLUEPRINTS_PER_KIND;
  await maybeEvictLowestHitBlueprint(deps.vectorStore, scope, input.kind, id, cap);

  const embeddingInput = composeEmbeddingInput(input.contract, input.intent);
  const vector = await deps.embedding.embed(embeddingInput);
  await deps.vectorStore.putVector(scope, {
    key: id,
    vector,
    metadata: blueprintToMetadata(blueprint),
  });
  return blueprint;
}

/**
 * If inserting `id` into (scope, kind) would push the bucket past
 * `cap`, delete the lowest-hitCount entry (oldest on ties). No-op
 * when:
 *   - cap is Infinity (eviction disabled),
 *   - the bucket is below cap,
 *   - the incoming key is already in the bucket (re-write doesn't grow),
 *   - the vector store isn't enumerable (hosted-only path).
 *
 * Eviction is best-effort — a failed delete won't block the put.
 * The cap is a soft ceiling; one over-cap state is preferable to
 * dropping a fresh registration.
 */
async function maybeEvictLowestHitBlueprint(
  store: VectorStore,
  scope: string,
  kind: BlueprintKind,
  incomingId: string,
  cap: number,
): Promise<void> {
  if (!Number.isFinite(cap)) return;
  if (!('listByScope' in store) || typeof store.listByScope !== 'function') {
    return;
  }
  const enumerable = store as EnumerableVectorStore;
  let bucket: VectorEntry[];
  try {
    const all = await enumerable.listByScope(scope);
    bucket = all.filter((entry) => {
      const k = readScalarString(entry.metadata[METADATA_KEYS.kind]);
      return k === kind;
    });
  } catch {
    return;
  }

  // Re-write of an existing key — the bucket size doesn't grow, so
  // no eviction needed.
  if (bucket.some((e) => e.key === incomingId)) return;
  if (bucket.length < cap) return;

  // Pick the entry with the lowest hitCount; on ties pick the oldest
  // createdAt. This lines up with LRU-by-importance: rarely-used
  // blueprints go first, and when nothing has been hit yet, the
  // oldest cold entry leaves.
  let victim: VectorEntry | null = null;
  let victimHits = Number.POSITIVE_INFINITY;
  let victimCreated = '￿'; // Sorts after every realistic ISO string
  for (const entry of bucket) {
    const hits =
      readScalarNumber(entry.metadata[METADATA_KEYS.hitCount]) ?? 0;
    const created =
      readScalarString(entry.metadata[METADATA_KEYS.createdAt]) ?? '';
    if (hits < victimHits || (hits === victimHits && created < victimCreated)) {
      victim = entry;
      victimHits = hits;
      victimCreated = created;
    }
  }
  if (!victim) return;
  try {
    await store.deleteVector(scope, victim.key);
  } catch {
    // Eviction is best-effort — let the put proceed even if delete
    // raced with another writer.
  }
}

/**
 * Tier 1 exact-key lookup — return the blueprint whose contract
 * canonicalizes to `contractKey`, or `null` if none exists.
 *
 * Implementation note: `VectorStore` lacks a `getByKey` primitive, so
 * we either listByScope+filter (works on every backend) or query+
 * filter-by-key (requires an embedding round-trip). We use
 * `listByScope` when an `EnumerableVectorStore` is available since
 * Tier 1 doesn't need the embedder; otherwise fall back to a
 * query-with-zero-vector + key filter, which works but burns one
 * cosine round-trip on every Tier 1 check. Production deployments
 * should always wire an enumerable store (every OSS default
 * satisfies this).
 */
export async function findBlueprintExact(
  deps: { vectorStore: VectorStore },
  scope: string,
  kind: BlueprintKind,
  contractKey: string,
): Promise<Blueprint | null> {
  const expectedId = composeBlueprintId(kind, contractKey);
  const store = deps.vectorStore;
  if ('listByScope' in store && typeof store.listByScope === 'function') {
    const entries = await (store as EnumerableVectorStore).listByScope(scope);
    for (const entry of entries) {
      if (entry.key === expectedId) {
        return rowToBlueprint(entry.key, entry.metadata);
      }
    }
    return null;
  }
  // Non-enumerable backend (S3 Vectors). Hash-search via the cosine
  // primitive. We construct an unrelated query vector — a zero vector
  // — which means cosine to all entries is 0; the result list ends up
  // ordered arbitrarily by the backend. Then we scan for the exact
  // key. Cost: one round-trip + a linear scan over the topK.
  // Inefficient for large scopes; OSS deployments use enumerable
  // stores so this branch is hosted-only.
  const dummy = new Array<number>(1).fill(0);
  const results = await store.query(scope, dummy, 1000);
  for (const result of results) {
    if (result.key === expectedId) {
      return rowToBlueprint(result.key, result.metadata);
    }
  }
  return null;
}

/**
 * Tier 2 retrieval — return the top-K blueprints whose embedding is
 * closest to the embedded `(intent, contract)` query.
 *
 * Filters by `kind` after the cosine sort; today only `'template'`
 * blueprints exist, but the filter future-proofs the call for
 * smaller-grain kinds.
 *
 * Returned blueprints carry `_cosine` on the result tuple so the
 * caller can hand it to the LLM rerank judge as a retrieval-score
 * hint.
 */
export interface BlueprintCandidate {
  readonly blueprint: Blueprint;
  readonly cosine: number;
}

export async function findBlueprintsByEmbedding(
  deps: BlueprintRegistryDeps,
  scope: string,
  query: { readonly intent: string; readonly contract?: DataContract },
  options: { readonly kind?: BlueprintKind; readonly topK?: number } = {},
): Promise<readonly BlueprintCandidate[]> {
  const topK = options.topK ?? 20;
  const embeddingInput = composeEmbeddingInput(query.contract, query.intent);
  const vector = await deps.embedding.embed(embeddingInput);
  const results = await deps.vectorStore.query(scope, vector, topK);
  const out: BlueprintCandidate[] = [];
  for (const result of results) {
    const blueprint = rowToBlueprint(result.key, result.metadata);
    if (!blueprint) continue;
    if (options.kind !== undefined && blueprint.kind !== options.kind) continue;
    out.push({ blueprint, cosine: result.score });
  }
  return out;
}

/**
 * Enumerate every blueprint in `scope`, optionally filtered by
 * `kind`. Used by the devtool registry view and by Tier 1 lookup on
 * enumerable backends. Requires an {@link EnumerableVectorStore}.
 */
export async function listBlueprints(
  deps: { vectorStore: EnumerableVectorStore },
  scope: string,
  kind?: BlueprintKind,
): Promise<readonly Blueprint[]> {
  const entries = await deps.vectorStore.listByScope(scope);
  const out: Blueprint[] = [];
  for (const entry of entries) {
    const blueprint = rowToBlueprint(entry.key, entry.metadata);
    if (!blueprint) continue;
    if (kind !== undefined && blueprint.kind !== kind) continue;
    out.push(blueprint);
  }
  return out;
}

/**
 * Bump `hitCount` + `lastHitAt` on a blueprint. Operator metric for
 * the devtool ("which blueprints are hot?"). Writes happen on the
 * registry-hit code path — accepted as one extra `putVector` per
 * Tier 1 / Tier 2 hit.
 */
export async function recordBlueprintHit(
  deps: { vectorStore: VectorStore } & Partial<BlueprintRegistryDeps>,
  scope: string,
  id: string,
): Promise<void> {
  // We need the existing entry to update it. Lookup via listByScope
  // when enumerable; otherwise via cosine query. Same shape as
  // findBlueprintExact's two branches.
  const store = deps.vectorStore;
  let existing: VectorEntry | VectorSearchResult | undefined;
  if ('listByScope' in store && typeof store.listByScope === 'function') {
    const entries = await (store as EnumerableVectorStore).listByScope(scope);
    existing = entries.find((e) => e.key === id);
  } else {
    const dummy = new Array<number>(1).fill(0);
    const results = await store.query(scope, dummy, 1000);
    existing = results.find((r) => r.key === id);
  }
  if (!existing) return;
  // Re-write the entry with bumped counters. Reuse the existing
  // vector — it's already correct for the canonical embedding input,
  // and re-embedding here would burn an unnecessary round-trip.
  // VectorSearchResult doesn't carry `vector`, only metadata + key,
  // so when we landed via the non-enumerable branch we can't reuse
  // the vector — re-embedding is the only path. Document this branch
  // as the hosted-only slow case; OSS always lands on the enumerable
  // branch above.
  const vector = 'vector' in existing ? existing.vector : await reembed(deps, existing.metadata);
  if (!vector) return; // re-embed failed silently — drop the hit-count update
  const nextHitCount =
    (readScalarNumber(existing.metadata[METADATA_KEYS.hitCount]) ?? 0) + 1;
  await store.putVector(scope, {
    key: id,
    vector,
    metadata: {
      ...existing.metadata,
      [METADATA_KEYS.hitCount]: nextHitCount,
      [METADATA_KEYS.lastHitAt]: new Date().toISOString(),
    },
  });
}

async function reembed(
  deps: Partial<BlueprintRegistryDeps>,
  metadata: Record<string, string | number | boolean | null>,
): Promise<number[] | null> {
  if (!deps.embedding) return null;
  const intent = readScalarString(metadata[METADATA_KEYS.intent]);
  const contractStr = readScalarString(metadata[METADATA_KEYS.contract]);
  if (intent === undefined || contractStr === undefined) return null;
  let contract: DataContract;
  try {
    contract = JSON.parse(contractStr) as DataContract;
  } catch {
    return null;
  }
  const input = composeEmbeddingInput(contract, intent);
  return deps.embedding.embed(input);
}

/**
 * Delete a blueprint by id. Idempotent — deleting a missing key is a
 * no-op (matches `VectorStore.deleteVector` contract).
 */
export async function deleteBlueprint(
  deps: { vectorStore: VectorStore },
  scope: string,
  id: string,
): Promise<void> {
  await deps.vectorStore.deleteVector(scope, id);
}
