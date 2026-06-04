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
 * ## Storage layout (uuid-keyed)
 *
 * Vector-store rows are keyed by an opaque `bp_<uuid>` id minted once at
 * first registration. The deterministic reuse identity lives in the
 * sibling {@link BlueprintIndex}, which maps the exact key
 * `${kind}:${contractKey}:${variantKey}` to that uuid. `kind` is the
 * atomic-design level (`'template'` for full components today;
 * `'organism'` / `'molecule'` / `'atom'` reserved for future
 * compositional decomposition).
 *
 * One blueprint per `(scope, kind, contractKey, variantKey)` tuple:
 * the same contract under distinct design-time variance blocks resolves
 * to distinct sibling rows (distinct exact keys → distinct uuids). The
 * default variant (absent / empty variance) hashes to one stable sentinel.
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
import { randomUUID } from 'node:crypto';
import type {
  BlueprintIndex,
  EmbeddingProvider,
  EnumerableVectorStore,
  VectorEntry,
  VectorSearchResult,
  VectorStore,
} from '@ggui-ai/mcp-server-core';

// Re-export the core seam so handlers-side consumers (matcher, render,
// ops-blueprint) name the index type from one barrel without reaching
// into `@ggui-ai/mcp-server-core` directly.
export type { BlueprintIndex } from '@ggui-ai/mcp-server-core';
import {
  summarizeContract,
  type BlueprintVariance,
  type DataContract,
} from '@ggui-ai/protocol';
// `blueprintKey` + `variantKey` are server-only — pulled in from a
// dedicated subpath because they import `node:crypto`, which browsers
// can't bundle.
import { blueprintKey, variantKey } from '@ggui-ai/protocol/blueprint-key';
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
  /**
   * Opaque registry id — `bp_<uuid>`, minted once at first registration.
   * Identity is no longer derived from `(kind, contractKey)`; the
   * deterministic exact-lookup key composes `(kind, contractKey,
   * variantKey)` and resolves to this id via the {@link BlueprintIndex}.
   */
  readonly id: string;
  readonly kind: BlueprintKind;
  /** Identity hash of `contract` — equal contract produce equal keys. */
  readonly contractKey: string;
  /**
   * Identity hash of the design-time {@link variance} block — the variant
   * axis of the reuse key. `(contractKey, variantKey)` identifies one
   * reusable component; runtime props are never an input. Self-normalizing:
   * `undefined` / `{}` / all-empty variance hash to one stable "default
   * variant" sentinel. See `variantKey()` in `@ggui-ai/protocol`.
   */
  readonly variantKey: string;
  /**
   * Design-time variance tags carried alongside the contract. The variant
   * selector reads these to pick the best fit; `variantKey` is their
   * identity hash. Defaults to `{}` (the default variant).
   */
  readonly variance: BlueprintVariance;
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

/** Compose deps for the registry — embedder + vector store + identity index. */
export interface BlueprintRegistryDeps {
  readonly embedding: EmbeddingProvider;
  readonly vectorStore: VectorStore;
  /**
   * `(scope, exactKey) → blueprintId` resolver. Sibling of
   * {@link vectorStore}: the vector store holds the embedding+metadata row;
   * this index resolves the deterministic exact-lookup key to the row's id
   * without a scope scan. Threaded now (plumbing wave); the dedup +
   * indexed exact lookup that consume it land next wave.
   */
  readonly index: BlueprintIndex;
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
  /**
   * Design-time variance tags for this registration. Drives the variant
   * axis of the reuse key via `variantKey(variance)`. Omitted → the
   * default variant (`{}`); the self-normalizing hash treats absent /
   * empty variance as one stable sentinel.
   */
  readonly variance?: BlueprintVariance;
}

/**
 * Compose the deterministic exact-lookup key — the `(scope, exactKey)`
 * half of the {@link BlueprintIndex} binding. Three-segment join
 * `${kind}:${contractKey}:${variantKey}` so the variant axis is part of
 * the reuse identity: two registrations of the same contract shape under
 * distinct variance blocks resolve to distinct exact keys (and so distinct
 * cached components). The index maps this key to the row's opaque
 * `bp_<uuid>` id; identity is never derived from `(kind, contractKey)`.
 */
export function composeExactKey(
  kind: BlueprintKind,
  contractKey: string,
  variantKey: string,
): string {
  return `${kind}:${contractKey}:${variantKey}`;
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
  variantKey: 'variantKey',
  variance: 'variance',
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
    [METADATA_KEYS.variantKey]: bp.variantKey,
    [METADATA_KEYS.variance]: JSON.stringify(bp.variance),
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

/**
 * Narrow a stored `kind` scalar to {@link BlueprintKind}, or `undefined`
 * when the row is foreign / malformed. Avoids an unchecked cast at the
 * index-key reconstruction site.
 */
function readBlueprintKind(
  value: string | number | boolean | null | undefined,
): BlueprintKind | undefined {
  if (
    value === 'template' ||
    value === 'organism' ||
    value === 'molecule' ||
    value === 'atom'
  ) {
    return value;
  }
  return undefined;
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
  const variance = readVariance(metadata[METADATA_KEYS.variance]);
  // Legacy rows (written before the variant axis existed) lack a
  // `variantKey`; default to the "default variant" sentinel so the row
  // still reconstructs and slots under the empty-variance identity.
  const variantKeyValue =
    readScalarString(metadata[METADATA_KEYS.variantKey]) ?? variantKey(undefined);
  return {
    id: key,
    kind: kindStr,
    contractKey,
    variantKey: variantKeyValue,
    variance,
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
 * Reconstruct a {@link BlueprintVariance} from the stored JSON blob.
 * Legacy rows (no `variance` key) and malformed JSON both resolve to the
 * default variant `{}` — the self-normalizing `variantKey()` hash treats
 * absent / empty variance as one stable sentinel, so this default never
 * shifts a legacy row's identity.
 */
function readVariance(
  value: string | number | boolean | null | undefined,
): BlueprintVariance {
  const str = readScalarString(value);
  if (str === undefined) return {};
  try {
    return JSON.parse(str) as BlueprintVariance;
  } catch {
    return {};
  }
}

/**
 * Default cap on registered blueprints per (scope, kind). When a
 * fresh registration would push the bucket past the cap,
 * {@link registerBlueprint} evicts the lowest-`hitCount` entry first;
 * ties broken by oldest `createdAt`. The number is calibrated for an
 * OSS single-tenant `ggui serve` workload — every render is one
 * `template` entry, so 100 templates per scope = ~100 distinct
 * UI shapes the agent has built across its renders, well above any
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
  /**
   * Override the UUID minter. Defaults to `() => \`bp_${randomUUID()}\``.
   * Tests inject a deterministic minter to assert id shape without
   * depending on `node:crypto` randomness. Only consulted on a fresh
   * registration — a dedup hit returns the existing row's id verbatim.
   */
  readonly mintId?: () => string;
}

/**
 * Register a blueprint into the scope.
 *
 * Identity: a fresh `(contractKey, variantKey)` mints an opaque
 * `bp_<uuid>` once and binds it in the {@link BlueprintIndex} under the
 * deterministic exact key. Dedup-on-first-registration: re-registering an
 * already-bound `(contractKey, variantKey)` returns the existing UUID+row
 * verbatim (first write wins — no re-mint, no metadata overwrite, no
 * hitCount reset). A dangling index binding (id present, row gone)
 * self-heals: the stale binding is dropped and registration proceeds as
 * a fresh mint.
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
  const vKey = variantKey(input.variance);
  const exactKey = composeExactKey(input.kind, contractKey, vKey);

  // Dedup-on-first-registration: a bound (contractKey, variantKey) returns its
  // existing UUID+row verbatim (first write wins, no re-mint, no hitCount reset).
  const existingId = await deps.index.getId(scope, exactKey);
  if (existingId) {
    const existing = await findBlueprintByUuid(deps.vectorStore, scope, existingId);
    if (existing) return existing;
    // Dangling binding (id present, row gone) — self-heal: drop the stale
    // binding and fall through to mint a fresh row.
    await deps.index.deleteId(scope, exactKey);
  }

  const id = options.mintId?.() ?? `bp_${randomUUID()}`;
  const variance = input.variance ?? {};
  const createdAt = new Date().toISOString();
  const blueprint: Blueprint = {
    id,
    kind: input.kind,
    contractKey,
    variantKey: vKey,
    variance,
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
  await maybeEvictLowestHitBlueprint(deps, scope, input.kind, cap);

  const embeddingInput = composeEmbeddingInput(input.contract, input.intent);
  const vector = await deps.embedding.embed(embeddingInput);
  await deps.vectorStore.putVector(scope, {
    key: id,
    vector,
    metadata: blueprintToMetadata(blueprint),
  });
  await deps.index.putId(scope, exactKey, id);
  return blueprint;
}

/**
 * If a fresh registration into (scope, kind) would push the bucket past
 * `cap`, delete the lowest-hitCount entry (oldest on ties). No-op when:
 *   - cap is Infinity (eviction disabled),
 *   - the bucket is below cap,
 *   - the vector store isn't enumerable (hosted-only path).
 *
 * Always called for a fresh mint — dedup is upstream now, so a
 * re-registration of an already-bound `(contractKey, variantKey)` never
 * reaches here (it returns the existing row before eviction). There is
 * therefore no re-write short-circuit: every call grows the bucket by one.
 *
 * After deleting the victim's vector, the victim's exact key is
 * reconstructed from its stored metadata (`kind` / `contractKey` /
 * `variantKey`) and dropped from the {@link BlueprintIndex} so the
 * binding doesn't dangle. Both deletes are best-effort — a failure
 * won't block the put. The cap is a soft ceiling; one over-cap state is
 * preferable to dropping a fresh registration.
 */
async function maybeEvictLowestHitBlueprint(
  deps: { vectorStore: VectorStore; index: BlueprintIndex },
  scope: string,
  kind: BlueprintKind,
  cap: number,
): Promise<void> {
  if (!Number.isFinite(cap)) return;
  const store = deps.vectorStore;
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
  // Drop the victim's index binding so it doesn't dangle. Reconstruct
  // the exact key from the victim's own metadata.
  const victimKind = readBlueprintKind(victim.metadata[METADATA_KEYS.kind]);
  const victimContractKey = readScalarString(
    victim.metadata[METADATA_KEYS.contractKey],
  );
  const victimVariantKey =
    readScalarString(victim.metadata[METADATA_KEYS.variantKey]) ??
    variantKey(undefined);
  if (victimKind !== undefined && victimContractKey !== undefined) {
    try {
      await deps.index.deleteId(
        scope,
        composeExactKey(victimKind, victimContractKey, victimVariantKey),
      );
    } catch {
      // Best-effort — a failed index delete leaves a self-healing
      // dangling binding, which `findBlueprintExact` resolves to null.
    }
  }
}

/**
 * Tier 1 exact lookup — resolve the blueprint bound to `(kind,
 * contractKey, variantKey)` via the {@link BlueprintIndex}, or `null` if
 * none exists.
 *
 * `variantKey_` is optional (named with a trailing underscore so it does
 * not shadow the imported `variantKey` helper). Omitted → the
 * default-variant sentinel, so a contract-only lookup resolves the
 * default variant. The index resolves the deterministic exact key to the
 * row's UUID in one point-read; an index hit that points at a missing
 * row (a dangling binding) resolves to `null` rather than throwing — the
 * read site is one of the two self-heal points for stale bindings.
 */
export async function findBlueprintExact(
  deps: { vectorStore: VectorStore; index: BlueprintIndex },
  scope: string,
  kind: BlueprintKind,
  contractKey: string,
  variantKey_?: string,
): Promise<Blueprint | null> {
  const vKey = variantKey_ ?? variantKey(undefined); // optional → default-variant
  const exactKey = composeExactKey(kind, contractKey, vKey);
  const id = await deps.index.getId(scope, exactKey);
  if (!id) return null;
  return findBlueprintByUuid(deps.vectorStore, scope, id); // UUID-miss after index-hit → null, never throw
}

/**
 * Point-read a blueprint by its vector-store key (id) within `scope`,
 * or `null` when absent. Two branches mirror {@link findBlueprintExact}:
 * `listByScope`+find on an {@link EnumerableVectorStore} (no embed
 * round-trip), else a zero-vector `query`+scan on a non-enumerable
 * backend.
 *
 * Distinct from `findBlueprintExact`, which resolves a `(kind,
 * contractKey)` lookup to the synthetic key first. This reads straight
 * by id — the shape the render-time point-read (next wave) needs once
 * the index resolves `(scope, exactKey) → id`.
 */
async function findBlueprintByUuid(
  store: VectorStore,
  scope: string,
  id: string,
): Promise<Blueprint | null> {
  if ('listByScope' in store && typeof store.listByScope === 'function') {
    const entries = await (store as EnumerableVectorStore).listByScope(scope);
    for (const entry of entries) {
      if (entry.key === id) {
        return rowToBlueprint(entry.key, entry.metadata);
      }
    }
    return null;
  }
  const dummy = new Array<number>(1).fill(0);
  const results = await store.query(scope, dummy, 1000);
  for (const result of results) {
    if (result.key === id) {
      return rowToBlueprint(result.key, result.metadata);
    }
  }
  return null;
}

/**
 * Public point-read wrapper — resolve a blueprint by its id within
 * `scope`, or `null` when absent. The render-time point-read path (the
 * next wave, once the index resolves `(scope, exactKey) → id`) uses this
 * to fetch the matched row without a contract re-hash.
 */
export async function readBlueprintById(
  deps: { vectorStore: VectorStore },
  scope: string,
  id: string,
): Promise<Blueprint | null> {
  return findBlueprintByUuid(deps.vectorStore, scope, id);
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
 *
 * Reads the row first so the `(kind, contractKey, variantKey)` exact key
 * can be reconstructed and dropped from the {@link BlueprintIndex}; the
 * index drop is best-effort (a missing row / failed delete leaves a
 * self-healing dangling binding, never an error).
 */
export async function deleteBlueprint(
  deps: { vectorStore: VectorStore; index: BlueprintIndex },
  scope: string,
  id: string,
): Promise<void> {
  const existing = await findBlueprintByUuid(deps.vectorStore, scope, id);
  await deps.vectorStore.deleteVector(scope, id);
  if (existing) {
    try {
      await deps.index.deleteId(
        scope,
        composeExactKey(existing.kind, existing.contractKey, existing.variantKey),
      );
    } catch {
      // Best-effort — a dangling binding self-heals at the read site.
    }
  }
}
